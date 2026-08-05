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
  InMemoryCallStore,
  JsonlCallStore,
  Workspace,
  type BrokerOpenSessionOptions,
  type BrokerLoadSessionOptions,
  type BrokerPromptOptions,
  type BrokerRunner,
  type BrokerSession,
  type BrokerTurn,
  type CallOutcome,
  type CallStore,
  type ReplEvalResult,
} from '../src/index.js';

const PROJECT = '/tmp/repl-broker-project';

/** Let queued host microtasks (openSession continuations, readiness
 *  flags) run. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fake held-open ACP session: the test drives turns and steer calls.
 *  Models acp-agents' preflight/handoff split: when `released` is set,
 *  prompt() rejects WITHOUT firing the handoff acknowledgment (the
 *  backend prompt is never invoked — the async pre-handoff rejection
 *  the review probe hit); otherwise it accepts the prompt. The seam
 *  order models the FIXED acp-agents contract (the crash-boundary
 *  regression): the backend prompt is registered (invoked) FIRST, and
 *  the handoff acknowledgment fires only after it — so a delivered
 *  marker recorded by the broker can never precede the hand-off. The
 *  `dieBeforeHandoff`/`dieAfterHandoff` modes simulate a process death
 *  in the seam itself. */
class FakeSession implements BrokerSession {
  readonly sessionId: string;
  capabilities: { supportsSteering: boolean } | undefined;
  readonly prompts: Array<{ content: string; resolve: (turn: BrokerTurn) => void; reject: (error: unknown) => void }> = [];
  readonly steers: Array<{ content: string; resolve: (outcome: string) => void; reject: (error: unknown) => void }> = [];
  cancelled = 0;
  releases = 0;
  /** When true, prompt() rejects pre-handoff (released session) — the
   *  handoff acknowledgment never fires and the backend is never
   *  invoked. */
  released = false;
  /** Crash-boundary simulation: the prompt is invoked (registered) and
   *  then the process dies BEFORE the handoff acknowledgment fires —
   *  the only interval the fixed seam leaves between "the backend
   *  received the prompt" and "the delivered marker is durable". The
   *  steer must stay undelivered-in-the-store: reconcile re-queues it
   *  (never lost). */
  dieBeforeHandoff = false;
  /** Crash-boundary simulation: the prompt is invoked, the handoff
   *  acknowledgment fires (the delivered marker is durable), and then
   *  the process dies — reconcile must never replay it (never
   *  duplicated). */
  dieAfterHandoff = false;
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

  prompt(content: string, opts: BrokerPromptOptions = {}): Promise<BrokerTurn> {
    if (this.released) {
      // The async pre-handoff rejection: the promise rejects and the
      // handoff acknowledgment is NEVER fired (acp-agents' preflight:
      // released session, aborted signal, prompt-in-flight).
      return Promise.reject(new Error('InteractiveSession has been released'));
    }
    this.texts.push(content);
    return new Promise((resolve, reject) => {
      // The backend prompt is invoked (registered) FIRST — the seam
      // order of the fixed acp-agents contract; the handoff
      // acknowledgment fires only after it.
      this.prompts.push({ content, resolve, reject });
      if (this.dieBeforeHandoff) {
        // The prompt reached the backend, but the process died before
        // the acknowledgment — the delivered marker was never recorded.
        reject(new Error('process died in the hand-off seam'));
        return;
      }
      if (this.dieAfterHandoff) {
        // The acknowledgment fires (the broker durably records the
        // delivered marker), then the process dies.
        opts.onHandoff?.();
        reject(new Error('process died after the delivered marker'));
        return;
      }
      // The handoff acknowledgment — the fake's model of acp-agents
      // invoking the backend prompt once every preflight passed.
      opts.onHandoff?.();
    });
  }

  steer(content: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.steers.push({ content, resolve, reject });
    });
  }

  /** The re-attach seam (phase D), mirroring the REAL acp-agents adapter:
   *  resolves IMMEDIATELY with a scripted loaded-turn outcome when one is
   *  set (the replay made the completed-while-down turn observable),
   *  parks otherwise (the still-running-at-load case). */
  readonly loadedTurns: Array<{ resolve: (turn: BrokerTurn) => void; reject: (error: unknown) => void }> = [];
  /** The seam's scripted loaded-turn outcome. Null parks the seam. */
  loadedTurnTextValue: string | null = null;
  awaitCurrentTurn(): Promise<BrokerTurn> {
    if (this.loadedTurnTextValue !== null) {
      return Promise.resolve({ stopReason: this.stopReason, text: this.loadedTurnTextValue });
    }
    return new Promise((resolve, reject) => {
      this.loadedTurns.push({ resolve, reject });
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
  readonly loadedWith: BrokerLoadSessionOptions[] = [];
  supportsSteering = true;
  /** The re-attach capability gate (phase D): models acp-agents'
   *  `supportsLoadSession` — a backend that does not advertise
   *  session/load rejects the load BEFORE any wire request. */
  supportsLoadSession = true;
  /** The scripted loaded-turn outcome for loadSession-created sessions
   *  (the real adapter resolves the seam from the session/load replay).
   *  Null parks the seam (the still-running-at-load case). */
  loadedTurnText: string | null = null;
  /** Open failures to inject (each one rejects openSession once). */
  failNextOpens = 0;
  /** Load failures to inject (each one rejects loadSession once). */
  failNextLoads = 0;
  disposeCalls = 0;

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
    if (!this.supportsLoadSession) {
      // The acp-agents capability gate (capabilities.ts): a backend
      // that omits session/load rejects before any wire request.
      throw new Error('backend does not advertise session/load (loadSession capability gate)');
    }
    if (this.failNextLoads > 0) {
      this.failNextLoads--;
      throw new Error('session not found at the backend');
    }
    const session = new FakeSession(opts);
    session.capabilities = { supportsSteering: this.supportsSteering };
    session.loadedTurnTextValue = this.loadedTurnText;
    this.sessions.push(session);
    return session;
  }

  async dispose(): Promise<void> {
    this.disposeCalls++;
  }

  last(): FakeSession {
    assert.ok(this.sessions.length > 0, 'a session must have been opened');
    return this.sessions[this.sessions.length - 1];
  }
}

/** Create a workspace + attached broker with a fake runner. */
async function setup(options: {
  maxConcurrentAgents?: number;
  runner?: FakeRunner;
  store?: ConstructorParameters<typeof Broker['attach']>[1]['store'];
  interruptHandler?: () => boolean;
} = {}) {
  const ws = await Workspace.create(PROJECT);
  const runner = options.runner ?? new FakeRunner();
  const broker = await Broker.attach(ws, {
    runner,
    store: options.store,
    maxConcurrentAgents: options.maxConcurrentAgents,
    interruptHandler: options.interruptHandler,
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
  // The call itself rejects with the machine-readable cancellation —
  // and the rejection is RECOVERABLE (review regression: it used to be
  // recoverable: false, which the guest combinators treat as a halt
  // signal — cancelling one worker then aborted the surrounding
  // parallel()/pipeline()). One call's cancellation must never abort
  // the orchestration owning it.
  const call = await broker.eval('await pi.catch((e) => e.code + "/" + e.recoverable)');
  assert.equal(call.result, '"AGENT_CANCELLED/true"');
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
    output(r).some((line) => line.startsWith('warn: ') && line.includes('delivery failed') && line.includes('worker crashed')),
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

// ────────────────────────────────────────────────────────────────────────
// Review-regression suite (phase C review round 1)
// ────────────────────────────────────────────────────────────────────────

test('review 1: the store\'s FIRST completion is authoritative — a newer live outcome never settles the guest against it', async () => {
  const { ws, broker, runner } = await setup();
  await broker.eval('const p = agent("pi/x", "task"); p.then((v) => console.log("settled:", v)); "started"');
  await tick();
  // A previous crash-retry already recorded the FIRST completion in the
  // store. The live outcome is newer AND different — the store wins.
  broker.store().recordCompleted('c1', { outcome: 'resolve', value: 'stored-first', completedAtMs: Date.now() });
  runner.last().completeTurn('live-second');
  await tick();
  const pumped = await broker.pump();
  assert.deepEqual(pumped, ['c1']);
  const r = await broker.eval('await p');
  assert.equal(r.result, '"stored-first"');
  assert.equal(broker.store().lookup('c1')!.completion!.value, 'stored-first');
  assert.equal(broker.store().lookup('c1')!.completion!.outcome, 'resolve');
  await ws.dispose();
});

test('review 1b: the cap is absolute for follow-up turns — an idle-session steer under cap pressure queues (queued) and starts only when a slot frees', async () => {
  const { ws, broker, runner } = await setup({ maxConcurrentAgents: 1 });
  // c1 opens and settles (idle).
  await broker.eval('const a = agent("pi/x", "a"); "started"');
  await tick();
  runner.sessions[0].completeTurn('a done');
  await tick();
  await broker.pump();
  // c2 opens and settles (idle) — admitted because c1's slot was freed.
  await broker.eval('const b = agent("pi/x", "b"); "started"');
  await tick();
  runner.sessions[1].completeTurn('b done');
  await tick();
  await broker.pump();
  const bSession = runner.sessions[1];
  // c3 now holds the workspace's ONLY slot.
  await broker.eval('const c = agent("pi/x", "c"); "started"');
  await tick();
  // A follow-up on the idle b handle must NOT start a turn while c3 is
  // in flight — the cap gates turn starts, not just dispatches (review
  // regression: idle-handle follow-ups used to start unconditionally,
  // so a cap-1 workspace ran two subagent turns concurrently). The
  // honest outcome is queued.
  const steered = await broker.eval('const o = await b.steer("more"); "outcome:" + o');
  assert.equal(steered.result, '"outcome:queued"');
  await tick();
  assert.equal(bSession.prompts.length, 0, 'no follow-up turn started under cap pressure');
  // c3 settles; its slot frees; the queued follow-up starts its turn.
  runner.sessions[2].completeTurn('c done');
  await tick();
  await broker.pump();
  await tick();
  assert.equal(bSession.prompts.length, 1, 'the queued follow-up started once a slot freed');
  assert.equal(bSession.prompts[0].content, 'more');
  await ws.dispose();
});

test('review 1c: queued delivery turns respect the cap across sessions — one follow-up turn at a time under cap 1', async () => {
  const runner = new FakeRunner();
  runner.supportsSteering = false;
  const { ws, broker } = await setup({ maxConcurrentAgents: 1, runner });
  // Two subagents, both settled and idle.
  await broker.eval('const a = agent("pi/x", "a"); "started"');
  await tick();
  runner.sessions[0].completeTurn('a done');
  await tick();
  await broker.pump();
  await broker.eval('const b = agent("pi/x", "b"); "started"');
  await tick();
  runner.sessions[1].completeTurn('b done');
  await tick();
  await broker.pump();
  // c3 now holds the workspace's ONLY slot.
  await broker.eval('const c = agent("pi/x", "c"); "started"');
  await tick();
  // A queued steer on each idle session (cap exhausted → both queue).
  await broker.eval('await a.steer("more-a"); "queued"');
  await broker.eval('await b.steer("more-b"); "queued"');
  assert.equal(runner.sessions[0].prompts.length, 0);
  assert.equal(runner.sessions[1].prompts.length, 0);
  // c settles → its slot frees → EXACTLY ONE queued delivery starts.
  runner.sessions[2].completeTurn('c done');
  await tick();
  await broker.pump();
  await tick();
  const withDelivery = [runner.sessions[0], runner.sessions[1]].filter((s) => s.prompts.length === 1);
  assert.equal(withDelivery.length, 1, 'exactly one delivery turn runs under cap 1');
  // It completes → the second delivery starts (the kick fires on every
  // freed slot, including the delivery turn's own end).
  withDelivery[0].completeTurn('delivered');
  await tick();
  await broker.pump();
  await tick();
  const remaining = [runner.sessions[0], runner.sessions[1]].filter((s) => s.prompts.length === 1);
  assert.equal(remaining.length, 1, 'the second queued steer delivered after the first turn ended');
  await ws.dispose();
});

test('review 2a: queued steering is durable — payload + founding session in the store, delivered marker recorded at the point of no return', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-broker-steer-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  runner.supportsSteering = false;
  await dispatchAgent(broker, runner);
  const queued = await broker.eval('await pi.steer("go deeper"); "queued"');
  assert.equal(queued.result, '"queued"');
  // The payload + founding session id live in the store (crash-durable —
  // a crash before delivery loses nothing).
  const steerRecord = broker.store().all().find((r) => r.kind === 'steer')!;
  assert.equal(steerRecord.sessionId, 'c1');
  assert.ok(steerRecord.optionsJson!.includes('go deeper'), 'the payload survives in the record');
  assert.equal(steerRecord.completion!.value, 'queued');
  assert.equal(steerRecord.deliveredAtMs, null, 'undelivered before the delivery turn starts');
  // The founding turn completes; the delivery turn starts — the prompt
  // is handed to the backend, and the delivered marker is recorded only
  // after that hand-off (the true point of no return: replay after it
  // would duplicate delivery, but a crash BEFORE it must not make a
  // restore skip a steer that was never delivered).
  runner.last().completeTurn('first pass');
  await tick();
  await broker.pump();
  assert.notEqual(broker.store().lookup('c2')!.deliveredAtMs, null, 'delivered marker recorded at the hand-off');
  await tick();
  assert.equal(runner.last().prompts[0].content, 'go deeper');
  runner.last().completeTurn('deeper results');
  await tick();
  await broker.pump();
  // A later reconcile must NOT re-queue the delivered steer.
  const report = await broker.reconcile();
  assert.deepEqual(report.reQueuedUndelivered, []);
  assert.equal(runner.last().prompts.length, 0, 'no duplicate delivery turn after reconcile');
  await ws.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('review 2b: a crash between enqueue and delivery loses nothing — reconcile re-queues undelivered steers from the store exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-broker-steer-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  runner.supportsSteering = false;
  const r1 = await broker.eval('const pi = agent("pi/x", "task"); const o = await pi.steer("go deeper"); "outcome:" + o');
  assert.equal(r1.result, '"outcome:queued"');
  await tick();
  // Simulated crash: snapshot before any settlement; dispose without
  // delivering anything. The store durably holds the queued steer.
  const snapshot = ws.snapshot();
  await broker.dispose();
  ws.dispose();
  // Restore: a fresh workspace + broker over the same store.
  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  runner2.supportsSteering = false;
  // c1's loaded turn observably completed while we were down (the real
  // adapter resolves the seam from the session/load replay) — the
  // re-attach arm awaits it INLINE during reconcile now.
  runner2.loadedTurnText = 'loaded turn';
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
  // The reconcile rebuilds the undelivered queue (the founding call is
  // still pending — its session re-attach delivers the re-queued steer
  // at open, the same merge path the same-eval test pins).
  const report = await broker2.reconcile();
  assert.deepEqual(report.settledFromStore, []);
  assert.deepEqual(report.reattached, ['c1'], 'the founding call re-attaches to its recorded backend session');
  assert.deepEqual(report.leftPending, []);
  assert.deepEqual(report.reQueuedUndelivered, ['c2']);
  // Idempotent: a second reconcile does not double-queue.
  const report2 = await broker2.reconcile();
  assert.deepEqual(report2.reQueuedUndelivered, []);
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('review 2c: a cancelled call drops its queued steers durably — reconcile never resurrects them', async () => {
  const { ws, broker, runner } = await setup();
  runner.supportsSteering = false;
  await dispatchAgent(broker, runner);
  await broker.eval('await pi.steer("go deeper"); "queued"');
  await broker.eval('const o = await pi.cancel(); "outcome:" + o');
  await tick();
  await broker.pump();
  assert.notEqual(broker.store().lookup('c2')!.droppedAtMs, null, 'the drop is recorded durably');
  const report = await broker.reconcile();
  assert.deepEqual(report.reQueuedUndelivered, [], 'a dropped steer is never re-queued');
  await ws.dispose();
});

test('review 2d: the delivered marker is recorded only AFTER the prompt was handed to the backend (crash-between-loss regression)', async () => {
  const inner = new InMemoryCallStore();
  let sessionRef: FakeSession | undefined;
  let markers = 0;
  const store = new class implements CallStore {
    recordDispatched(r: Parameters<CallStore['recordDispatched']>[0]): void {
      inner.recordDispatched(r);
    }
    recordReissued(callId: string, atMs: number): void {
      inner.recordReissued(callId, atMs);
    }
    recordAttached(callId: string, sessionId: string, atMs: number): void {
      inner.recordAttached(callId, sessionId, atMs);
    }
    recordCompleted(callId: string, outcome: CallOutcome): boolean {
      return inner.recordCompleted(callId, outcome);
    }
    recordDelivery(callId: string, state: 'delivered' | 'dropped', atMs: number): void {
      if (state === 'delivered') {
        // The review regression: the marker used to be written before
        // session.prompt was invoked, so a crash between the two made
        // reconcile skip a steer that was never handed to the backend
        // (silently losing promised queued delivery). The marker must
        // never precede the hand-off.
        assert.ok(
          sessionRef !== undefined && sessionRef.prompts.length > 0,
          'the prompt hand-off must precede the delivered marker',
        );
        markers++;
      }
      inner.recordDelivery(callId, state, atMs);
    }
    lookup(callId: string) {
      return inner.lookup(callId);
    }
    all() {
      return inner.all();
    }
  }();
  const runner = new FakeRunner();
  runner.supportsSteering = false;
  const { ws, broker } = await setup({ store, runner });
  await dispatchAgent(broker, runner);
  sessionRef = runner.last();
  await broker.eval('await pi.steer("go deeper"); "queued"');
  runner.last().completeTurn('first pass');
  await tick();
  await broker.pump();
  assert.equal(markers, 1, 'the delivered marker was recorded exactly once, after the hand-off');
  assert.equal(runner.last().prompts.length, 1, 'the queued content became the next turn');
  await ws.dispose();
});

test('review 2e: an async pre-handoff prompt rejection never records the delivered marker — the steer stays re-deliverable (never skipped by reconcile)', async () => {
  const runner = new FakeRunner();
  runner.supportsSteering = false;
  const { ws, broker } = await setup({ runner });
  await dispatchAgent(broker, runner);
  const session = runner.last();
  // The adversarial probe: the session is released while the delivery
  // turn is being started. The fake models acp-agents' async preflight
  // rejection (released session / aborted signal / prompt-in-flight):
  // the prompt promise rejects and the handoff acknowledgment NEVER
  // fires — the backend prompt is never invoked.
  session.released = true;
  await broker.eval('await pi.steer("go deeper"); "queued"');
  // The founding turn completes; the kick starts the delivery turn,
  // whose prompt pre-handoff-rejects (asynchronously).
  session.completeTurn('first pass');
  await tick();
  await broker.pump();
  await tick();
  const record = broker.store().lookup('c2')!;
  assert.equal(
    record.deliveredAtMs,
    null,
    'no delivered marker for a steer the backend never saw (the regression: the marker used to be non-null)',
  );
  assert.equal(record.droppedAtMs, null, 'not dropped either — the next-turn delivery is still owed');
  assert.equal(record.completion!.value, 'queued', 'the queued acceptance stands');
  // Nothing is hidden: the failed delivery surfaces as a warn line in
  // the next tool result.
  const probe = await broker.eval('"probe"');
  assert.ok(
    output(probe).some((l) => l.startsWith('warn: ') && l.includes('delivery failed') && l.includes('released')),
    output(probe).join('\n'),
  );
  // Reconcile re-queues the never-delivered steer (the regression: the
  // non-null marker used to make the queue rebuild skip it forever).
  const report = await broker.reconcile();
  assert.deepEqual(report.reQueuedUndelivered, ['c2']);
  // The re-queued steer is still deliverable: the session re-attaches
  // (the restore path's analog — the released flag clears) and a freed
  // concurrency slot kicks the delivery.
  session.released = false;
  await broker.eval('const q = agent("pi/y", "other"); "ok"');
  await tick();
  const other = runner.last();
  other.completeTurn('other done');
  await tick();
  await broker.pump();
  await tick();
  assert.equal(session.prompts.length, 1, 'the re-queued steer was delivered once the session re-attached');
  session.completeTurn('deeper results');
  await tick();
  await broker.pump();
  assert.notEqual(broker.store().lookup('c2')!.deliveredAtMs, null, 'the re-delivered steer records its delivered marker');
  await ws.dispose();
});

test('review 7a (the true crash-boundary regression): a process death between the backend hand-off and the delivered marker leaves the steer re-deliverable — reconcile re-queues it, never loses it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-broker-crash-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  runner.supportsSteering = false;
  await dispatchAgent(broker, runner);
  const session = runner.last();
  await broker.eval('await pi.steer("go deeper"); "queued"');
  // The delivery turn starts; the fake models the fixed acp-agents seam
  // (prompt invoked first, then the handoff acknowledgment). The
  // process dies in the ONLY interval the fixed seam leaves: after the
  // backend prompt was invoked, before the acknowledgment fired — the
  // delivered marker was never recorded.
  session.dieBeforeHandoff = true;
  session.completeTurn('first pass');
  await tick();
  await broker.pump();
  await tick();
  const record = broker.store().lookup('c2')!;
  assert.equal(record.deliveredAtMs, null, 'no marker — the steer is undelivered-in-the-store');
  assert.equal(record.completion!.value, 'queued', 'the queued acceptance stands');
  // Nothing is hidden: the delivery failure surfaces as a warn line.
  const probe = await broker.eval('"probe"');
  assert.ok(
    output(probe).some((l) => l.startsWith('warn: ') && l.includes('delivery failed') && l.includes('hand-off seam')),
    output(probe).join('\n'),
  );
  // The restore's reconcile re-queues the never-delivered steer (the
  // regression: with the marker written BEFORE the invocation, a crash
  // in that interval left the steer marked delivered and skipped
  // forever).
  const report = await broker.reconcile();
  assert.deepEqual(report.reQueuedUndelivered, ['c2']);
  // The re-queued steer is delivered exactly once on the next kick (a
  // freed slot — the founding session is idle again). The died delivery
  // turn stays registered in the fake; the re-delivery is the NEXT
  // registered prompt.
  session.dieBeforeHandoff = false;
  const promptsAfterDeath = session.prompts.length;
  await broker.eval('const q = agent("pi/y", "other"); "ok"');
  await tick();
  runner.last().completeTurn('other done');
  await tick();
  await broker.pump();
  await tick();
  assert.equal(session.prompts.length, promptsAfterDeath + 1, 'the re-queued steer was delivered once a slot freed');
  assert.equal(session.prompts[promptsAfterDeath].content, 'go deeper');
  session.prompts[promptsAfterDeath].resolve({ stopReason: 'end_turn', text: 'deeper results' });
  await tick();
  await broker.pump();
  assert.notEqual(broker.store().lookup('c2')!.deliveredAtMs, null, 'the re-delivered steer records its marker');
  const report2 = await broker.reconcile();
  assert.deepEqual(report2.reQueuedUndelivered, [], 'delivered exactly once — never re-queued again');
  await ws.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('review 7b (the crash-boundary regression, delivered side): a process death AFTER the delivered marker is durable never replays the steer', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  runner.supportsSteering = false;
  await dispatchAgent(broker, runner);
  const session = runner.last();
  await broker.eval('await pi.steer("go deeper"); "queued"');
  // The delivery turn dies after the handoff acknowledgment fired — the
  // marker is durable, the payload was on the wire; replay would
  // duplicate the delivery.
  session.dieAfterHandoff = true;
  session.completeTurn('first pass');
  await tick();
  await broker.pump();
  await tick();
  assert.notEqual(broker.store().lookup('c2')!.deliveredAtMs, null, 'the marker was recorded at the hand-off');
  // Nothing is hidden: the failed delivery surfaces as a warn line.
  const probe = await broker.eval('"probe"');
  assert.ok(
    output(probe).some((l) => l.startsWith('warn: ') && l.includes('delivery failed') && l.includes('after the delivered marker')),
    output(probe).join('\n'),
  );
  // Reconcile must NOT replay the delivered steer — no duplicate
  // delivery turns (the one registered prompt is the original delivery,
  // which died after the marker; reconcile must not start another).
  session.dieAfterHandoff = false;
  const promptsAtFailure = session.prompts.length;
  const report = await broker.reconcile();
  assert.deepEqual(report.reQueuedUndelivered, []);
  assert.equal(session.prompts.length, promptsAtFailure, 'no duplicate delivery turn');
  await ws.dispose();
});

test('review 3: a failing store write during checkpoint.answer leaves the checkpoint pending — a later answer retry succeeds', async () => {
  const inner = new InMemoryCallStore();
  const store = new class implements CallStore {
    failNextCompletion = false;
    recordDispatched(r: Parameters<CallStore['recordDispatched']>[0]): void {
      inner.recordDispatched(r);
    }
    recordReissued(callId: string, atMs: number): void {
      inner.recordReissued(callId, atMs);
    }
    recordAttached(callId: string, sessionId: string, atMs: number): void {
      inner.recordAttached(callId, sessionId, atMs);
    }
    recordCompleted(callId: string, outcome: CallOutcome): boolean {
      if (this.failNextCompletion) {
        this.failNextCompletion = false;
        throw new Error('disk full');
      }
      return inner.recordCompleted(callId, outcome);
    }
    recordDelivery(callId: string, state: 'delivered' | 'dropped', atMs: number): void {
      inner.recordDelivery(callId, state, atMs);
    }
    lookup(callId: string) {
      return inner.lookup(callId);
    }
    all() {
      return inner.all();
    }
  }();
  const { ws, broker } = await setup({ store });
  await broker.eval('const q = checkpoint("What color?"); "raised"');
  // The answer's record write fails: the host callback throws, the guest
  // answer call fails, and the checkpoint stays PENDING (it must not be
  // consumed before its answer is durable — review regression).
  store.failNextCompletion = true;
  const failed = await broker.eval('checkpoint.answer("c1", "blue")');
  assert.equal(failed.result, undefined);
  assert.ok(output(failed).some((l) => l.includes('disk full')), output(failed).join('\n'));
  assert.deepEqual((await broker.eval('"probe"')).checkpoints.map((c) => c.id), ['c1']);
  assert.equal(broker.store().lookup('c1')!.completion, null, 'nothing was recorded');
  // The retry (with the store healthy again) delivers the answer.
  const ok = await broker.eval('checkpoint.answer("c1", "blue"); "delivered"');
  assert.equal(ok.result, '"delivered"');
  const r = await broker.eval('await q');
  assert.equal(r.result, '"blue"');
  assert.equal(broker.store().lookup('c1')!.completion!.value, 'blue');
  await ws.dispose();
});

test('review 4: the guest schema reaches session creation — the native schema channels are configured, not validated blind', async () => {
  const { ws, broker, runner } = await setup();
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
  await dispatchAgent(
    broker,
    runner,
    `const p = agent("pi/x", "task", { schema: ${JSON.stringify(schema)} }); "ok"`,
  );
  assert.deepEqual(runner.openedWith[0].schema, schema, 'the schema rides openSession (session/new channel + per-turn channels)');
  await ws.dispose();
});

test('review 5: the concurrency cap validates — default 6, over-ceiling clamps to 6, invalid values throw at attach', async () => {
  const { ws, broker } = await setup();
  assert.equal(broker.maxConcurrentAgents, 6, 'the doc-settled default');
  await ws.dispose();
  // Over the ceiling: clamped (the six-per-workspace maximum is absolute).
  const { ws: ws2, broker: broker2 } = await setup({ maxConcurrentAgents: 7 });
  assert.equal(broker2.maxConcurrentAgents, 6);
  await ws2.dispose();
  // Invalid values are programming errors at attach time.
  for (const bad of [NaN, 0, -1, 1.5, Infinity]) {
    await assert.rejects(
      async () => Broker.attach(await Workspace.create(PROJECT), { runner: new FakeRunner(), maxConcurrentAgents: bad }),
      new RegExp('maxConcurrentAgents must be an integer'),
    );
  }
  // At the ceiling: six sessions open, the seventh dispatch is refused.
  const { ws: ws3, broker: broker3, runner: runner3 } = await setup();
  const r = await broker3.eval('for (let i = 0; i < 7; i++) agent("pi/x", "t" + i); "started"');
  assert.equal(r.result, '"started"');
  await tick();
  assert.equal(runner3.sessions.length, 6, 'six sessions opened — never seven');
  assert.equal(broker3.store().lookup('c7')!.completion!.outcome, 'reject');
  assert.ok(r.completed.includes('c7'), 'the refusal is reported in completed');
  await ws3.dispose();
});

test('review 6: an agent call whose session never opens releases its concurrency slot (cap 1 — the next dispatch is admitted)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ maxConcurrentAgents: 1, runner });
  runner.failNextOpens = 1;
  await broker.eval('const p = agent("pi/x", "boom"); "started"');
  await tick(); // openSession rejects
  await broker.pump(); // the rejection settles; the slot MUST be released
  assert.equal(broker.store().lookup('c1')!.completion!.outcome, 'reject');
  const r = await broker.eval('await p.catch((e) => e.message)');
  assert.ok(String(r.result).includes('spawn failed'), String(r.result));
  const admitted = await broker.eval('const p2 = agent("pi/x", "ok"); "started"');
  assert.equal(admitted.result, '"started"', 'the second dispatch was admitted after the failed open');
  await tick();
  assert.equal(runner.sessions.length, 1);
  await ws.dispose();
});

test('review 7: same-eval steers of a call whose session never opens are dropped with the documented warning (outcome visibility)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  runner.failNextOpens = 1;
  const r1 = await broker.eval('const pi = agent("pi/x", "task"); const o = await pi.steer("same eval"); "outcome:" + o');
  assert.equal(r1.result, '"outcome:queued"');
  await tick(); // open fails; the pending steers are dropped + warned
  await broker.pump();
  const r2 = await broker.eval('"probe"');
  assert.ok(
    output(r2).some((l) => l.startsWith('warn: ') && l.includes('delivery failed') && l.includes('spawn failed')),
    output(r2).join('\n'),
  );
  // The drop is durable: reconcile never resurrects it.
  assert.notEqual(broker.store().lookup('c2')!.droppedAtMs, null);
  const report = await broker.reconcile();
  assert.deepEqual(report.reQueuedUndelivered, []);
  await ws.dispose();
});

test('review 8: an interrupted continuation keeps the already-settled ids in the eval\'s completed list', async () => {
  let checks = 0;
  const { ws, broker, runner } = await setup({ interruptHandler: () => ++checks > 20000 });
  await broker.eval('const p = agent("pi/x", "task"); p.then(() => { let i = 0; while (true) i++; }); "started"');
  await tick();
  runner.last().completeTurn('final');
  await tick();
  // The eval's OWN pump delivers c1, then its drain runs the runaway
  // continuation, which the interrupt handler breaks: the eval returns
  // the drain-failure line AND the ids it settled before the drain
  // failed (review regression: completed used to come back empty).
  const r = await broker.eval('"probe"');
  assert.deepEqual(r.completed, ['c1'], 'the settled id survives the drain failure');
  assert.ok(
    output(r).some((l) => l.includes('interrupted') || l.includes('Job execution error')),
    output(r).join('\n'),
  );
  // pump() still propagates the drain failure as its public contract.
  checks = 0;
  await broker.eval('const p2 = agent("pi/x", "task2"); p2.then(() => { let i = 0; while (true) i++; }); "started"');
  await tick();
  runner.last().completeTurn('final2');
  await tick();
  await assert.rejects(() => broker.pump(), (e: unknown) =>
    (e as Error).message.includes('Job execution error'),
  );
  await ws.dispose();
});

test('review 8b: the broker-level interrupt handler bounds a DIRECT runaway eval (the default ReplEvalOptions handler)', async () => {
  let checks = 0;
  const { ws, broker } = await setup({ interruptHandler: () => ++checks > 1000 });
  // No settlement involved: the eval itself runs away. The broker's
  // configured handler must bound it (review regression: it used to
  // apply only to settlement drains, so a direct runaway eval could
  // hang the workspace indefinitely).
  const r = await broker.eval('let i = 0; while (true) i++;');
  assert.equal(r.result, undefined);
  assert.ok(output(r).some((l) => l.includes('InternalError: interrupted')), output(r).join('\n'));
  assert.ok(checks > 1000, 'the broker-level handler fired');
  // The broker default is a floor: a per-eval handler overrides it
  // (the broker's own closure must not fire while the override runs).
  const brokerChecks = checks;
  let perEval = 0;
  const r2 = await broker.eval('let j = 0; while (true) j++;', { interruptHandler: () => ++perEval > 1000 });
  assert.ok(output(r2).some((l) => l.includes('InternalError: interrupted')), output(r2).join('\n'));
  assert.ok(perEval > 1000, 'the per-eval handler fired');
  assert.equal(checks, brokerChecks, 'the broker default did not fire under the per-eval override');
  await ws.dispose();
});

test('review 9: the guest "default" model sentinel maps to an OMITTED model — verify/judgePanel combinator coverage', async () => {
  const { ws, broker, runner } = await setup();
  // verify() routes its reviewers through the reserved "default"
  // sentinel (no per-call model in the DSL options).
  await broker.eval('const v = verify("some claim", { reviewers: 2 }); "started"');
  await tick();
  assert.equal(runner.openedWith.length, 2);
  assert.ok(
    runner.openedWith.every((o) => o.model === undefined),
    'the sentinel never reaches the runner as a literal model selection',
  );
  for (const session of runner.sessions) session.completeTurn('{"real": true, "reason": "ok"}');
  await tick();
  await broker.pump();
  const v = await broker.eval('await v');
  assert.equal(v.result, '{real: true, realCount: 2, total: 2, votes: Array(2)}');
  // judgePanel() graders route the same way.
  await broker.eval('const jp = judgePanel(["a", "b"], { judges: 2 }); "started"');
  await tick();
  assert.equal(runner.openedWith.length, 6);
  assert.ok(runner.openedWith.slice(2).every((o) => o.model === undefined));
  await ws.dispose();
});

test('review 10: dispose releases every session the broker opened, even with a host-injected runner', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await dispatchAgent(broker, runner);
  runner.last().completeTurn('done');
  await tick();
  await broker.pump();
  assert.equal(runner.sessions.length, 1);
  await broker.dispose();
  assert.equal(runner.sessions[0].releases, 1, 'the dedicated session was released');
  assert.equal(runner.disposeCalls, 0, 'the injected runner itself is the host\'s to dispose');
  await ws.dispose();
});
