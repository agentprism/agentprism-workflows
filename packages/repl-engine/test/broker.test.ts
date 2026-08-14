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
  /** Diagnostic-open failures to inject (each one rejects an openSession
   *  WITHOUT configOptions — the [C]5 fallback's reopen — once). */
  failDiagnosticOpens = 0;
  /** Load failures to inject (each one rejects loadSession once). */
  failNextLoads = 0;
  /** When true, loadSession PARKS (the caller releases it through
   *  `releaseParkedLoad`) — the delayed-load probe for the §4.2
   *  mint-time addressability of lazy re-attach turns (a followUp on a
   *  drained settled handle, or a restore whose queue rebuild
   *  re-attaches the founding session). */
  parkLoads = false;
  readonly parkedLoads: Array<{
    opts: BrokerLoadSessionOptions;
    resolve: (session: FakeSession) => void;
    reject: (error: unknown) => void;
  }> = [];

  /** Resolve the oldest parked load with a fresh session (the
   *  loadSession-shaped creation — capabilities and the scripted
   *  loaded-turn outcome stamp like the normal path). */
  releaseParkedLoad(): FakeSession {
    const parked = this.parkedLoads.shift();
    assert.ok(parked, 'a loadSession call must be parked');
    const session = new FakeSession(parked.opts);
    session.capabilities = { supportsSteering: this.supportsSteering };
    session.loadedTurnTextValue = this.loadedTurnText;
    this.sessions.push(session);
    parked.resolve(session);
    return session;
  }
  disposeCalls = 0;
  /** Extra registered custom backends (appended to the known list). */
  extraBackends: string[] = [];
  /** The static config-option vocabularies the runner publishes (the
   *  §4.1 admission seam). Empty/absent = dynamic (undefined). */
  staticConfigOptions: Record<string, string[]> = {};
  /** configOptions keys the backend rejects at open (the dynamic-
   *  vocabulary late failure the [C]5 fallback covers). */
  failConfigKeys: Set<string> = new Set();
  /** The backend's own error message for a rejected config option
   *  (defaults to a key-free message). Lets tests model backends whose
   *  late error names an accepted sibling while omitting the actual
   *  rejected key — the [C]5 message-short-circuit defect. */
  failConfigMessage = 'invalid config option';

  listBackends(): string[] {
    return ['claude', 'codex', 'opencode', 'pi', ...this.extraBackends];
  }

  defaultBackendId(): string {
    return 'claude';
  }

  knownConfigOptionIds(backendId: string): string[] | undefined {
    return this.staticConfigOptions[backendId];
  }

  async openSession(opts: BrokerOpenSessionOptions): Promise<FakeSession> {
    if (this.failNextOpens > 0) {
      this.failNextOpens--;
      throw new Error('spawn failed');
    }
    if (opts.configOptions !== undefined) {
      for (const key of Object.keys(opts.configOptions)) {
        if (this.failConfigKeys.has(key)) {
          throw new Error(this.failConfigMessage);
        }
      }
    }
    if (opts.configOptions === undefined && this.failDiagnosticOpens > 0) {
      this.failDiagnosticOpens--;
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
    if (this.parkLoads) {
      return new Promise<FakeSession>((resolve, reject) => {
        this.parkedLoads.push({ opts, resolve, reject });
      });
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

  // Object completion values render the §4.4 depth-limited repr
  // (nested collections expand to depth 2; deeper levels collapse).
  const obj = await broker.eval('({ sections: [{ title: "Auth flow" }], n: 3 })');
  assert.equal(obj.result, '{sections: [{…}], n: 3}');

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
  assert.equal(started.result, 'ok');
  assert.deepEqual(started.pending, ['c1', 'c2']);

  // Settle both; the suspended eval's continuation runs at settlement.
  runner.sessions[0].completeTurn('hello');
  runner.sessions[1].completeTurn('world');
  await tick();
  const pumped = await broker.pump();
  assert.deepEqual(pumped, ['c1', 'c2']);
  await ws.dispose();
});

test('the fused-eval seam: waitForCalls reports the suspended eval\'s completion — kind/result attributed by the continuation token, with the late-error and still-pending arms', async () => {
  const { ws, broker, runner } = await setup();
  // The suspended eval completes during the wait's pumps: the wait
  // reports the completion's kind and repr, attributed to THIS eval via
  // its continuation token (a concurrent client's eval can never steal
  // the attribution).
  const r1 = await broker.eval('const r = await agent("pi/x", "task"); "done:" + r');
  assert.equal(r1.kind, 'pending');
  const waiting = broker.waitForCalls(undefined, 5000, r1.evalToken);
  await tick();
  runner.last().completeTurn('hello');
  const waited = await waiting;
  assert.equal(waited.drained, true);
  assert.equal(waited.result.kind, 'value');
  assert.equal(waited.result.result, 'done:hello');
  assert.equal(waited.result.evalToken, undefined, 'wait results carry no token of their own');
  // The settled eval's completion became `_` on the way.
  assert.equal((await broker.eval('_')).result, 'done:hello');
  // A LATE ERROR: the suspended eval rejects during the wait's pumps —
  // the wait reports kind 'error' (the rendering is in the output
  // lines) and no result.
  const r2 = await broker.eval('const q = agent("pi/x", "task2"); await q; "never"');
  const waiting2 = broker.waitForCalls(undefined, 5000, r2.evalToken);
  await tick();
  runner.last().completeTurn('');
  const waited2 = await waiting2;
  assert.equal(waited2.result.kind, 'error');
  assert.equal(waited2.result.result, undefined);
  assert.ok(
    output(waited2.result).some((line) => line.includes('no assistant output')),
    `the late error rendered in the wait's output: ${output(waited2.result).join('\n')}`,
  );
  // STILL PENDING: the eval awaits a call that never settles within
  // the bound — kind stays 'pending' with the in-flight ids.
  const r3 = await broker.eval('const t = agent("pi/x", "never-settles"); await t');
  const waiting3 = broker.waitForCalls(undefined, 200, r3.evalToken);
  const waited3 = await waiting3;
  assert.equal(waited3.result.kind, 'pending', 'the eval is still suspended at the bound');
  assert.ok(waited3.result.pending.length > 0, 'the in-flight ids are reported');
  assert.equal(waited3.result.result, undefined, 'no completion value while suspended');
  await ws.dispose();
});

test('a suspended eval continues at settlement like a .then: its output lands in the next tool result', async () => {
  const { ws, broker, runner } = await setup();
  const r1 = await broker.eval('const r = await agent("pi/x", "task"); console.log("got", r); "done:" + r');
  assert.equal(r1.kind, 'pending');
  assert.match(r1.evalToken ?? '', /^e\d+$/, 'the continuation token rides the eval result (the fused-eval seam)');
  assert.deepEqual(r1.pending, ['c1']);
  await tick();
  runner.last().completeTurn('hello');
  await tick();
  await broker.pump();
  const r2 = await broker.eval('"probe"');
  assert.ok(
    output(r2).some((line) => line === 'got hello'),
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
  await ws.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// Agent options and result shaping
// ────────────────────────────────────────────────────────────────────────

test('agent options: the §4.1 option bag (schema, cwd, configOptions, mode) maps onto the runner (cwd default, label, runId, keepSession, retainSessionLog)', async () => {
  const { ws, broker, runner } = await setup();
  await dispatchAgent(
    broker,
    runner,
    'const pi = agent("pi/deepseek-v4-flash-max", "research X", { configOptions: { thinking: true }, cwd: "/tmp/elsewhere", mode: "read-only" }); "ok"',
  );
  const opened = runner.openedWith[0];
  assert.equal(opened.model, 'pi/deepseek-v4-flash-max');
  assert.equal(opened.cwd, '/tmp/elsewhere');
  assert.deepEqual(opened.configOptions, { thinking: true });
  assert.equal(opened.mode, 'read-only');
  assert.equal(opened.label, 'repl:c1', 'the label is broker-owned (no guest label key)');
  assert.equal(opened.runId, 'c1');
  assert.equal(opened.keepSession, true);
  assert.equal(opened.retainSessionLog, true);
  await ws.dispose();
});

test('agent options: every known undefined-valued key is absent and dispatches', async () => {
  const { ws, broker, runner } = await setup();
  const options = [
    '{ schema: undefined }',
    '{ cwd: undefined }',
    '{ configOptions: undefined }',
    '{ mode: undefined }',
    '{ cwd: "/tmp", schema: undefined }',
    '{ configOptions: { thinkingLevel: undefined } }',
  ];
  for (const option of options) {
    const result = await broker.eval(`agent("pi/x", "t", ${option}); "started"`);
    assert.equal(result.result, 'started', `${option} is admitted`);
  }
  await tick();
  assert.equal(runner.sessions.length, options.length, 'every known-key case reaches backend dispatch');
  assert.ok(runner.sessions.every((session) => session.prompts.length === 1), 'every initial turn is in flight');
  assert.equal(runner.openedWith[0].schema, undefined);
  assert.equal(runner.openedWith[1].cwd, PROJECT);
  assert.equal(runner.openedWith[2].configOptions, undefined);
  assert.equal(runner.openedWith[3].mode, undefined);
  assert.equal(runner.openedWith[4].cwd, '/tmp');
  assert.deepEqual(runner.openedWith[5].configOptions, {});
  await ws.dispose();
});

test('agent options: a relative cwd and unknown keys refuse the call with recoverable: false; the unknown-key error ENUMERATES the valid keys', async () => {
  const { ws, broker, runner } = await setup();
  const r1 = await broker.eval('await agent("pi/x", "t", { cwd: "relative" }).catch(e => e.code + "/" + e.recoverable)');
  assert.equal(r1.result, 'SCRIPT_VALIDATION_ERROR/false');
  const r2 = await broker.eval('await agent("pi/x", "t", { bogus: 1 }).catch(e => e.code + "|" + e.message)');
  assert.equal(r2.result, 'SCRIPT_VALIDATION_ERROR|agent options: unknown option "bogus" (valid options: schema, cwd, configOptions, mode)');
  const r3 = await broker.eval('await agent("pi/x", "t", { label: "nope" }).catch(e => e.code)');
  assert.equal(r3.result, 'SCRIPT_VALIDATION_ERROR', 'the deleted label/meta/promptMeta/tier/toolNames keys are unknown options');
  const r4 = await broker.eval('await agent("pi/x", "t", { schema: 42 }).catch(e => e.code)');
  assert.equal(r4.result, 'SCRIPT_VALIDATION_ERROR');
  const r5 = await broker.eval(
    'await agent("pi/x", "t", { bogus: undefined }).catch(e => e.code + "|" + e.message)',
  );
  assert.equal(
    r5.result,
    'SCRIPT_VALIDATION_ERROR|agent options: unknown option "bogus" (valid options: schema, cwd, configOptions, mode)',
    'an undefined value cannot make the unknown key disappear before host admission validation',
  );
  const r6 = await broker.eval(
    'await agent("pi/x", "t", { bogus: function () {} }).catch(e => e.code + "|" + e.message)',
  );
  assert.equal(
    r6.result,
    'SCRIPT_VALIDATION_ERROR|agent options: unknown option "bogus" (valid options: schema, cwd, configOptions, mode)',
    'a function value cannot make the unknown key disappear before host admission validation',
  );
  const r7 = await broker.eval(
    'await agent("pi/x", "t", { bogus: Symbol("s") }).catch(e => e.code + "|" + e.message)',
  );
  assert.equal(
    r7.result,
    'SCRIPT_VALIDATION_ERROR|agent options: unknown option "bogus" (valid options: schema, cwd, configOptions, mode)',
    'a symbol value cannot make the unknown key disappear before host admission validation',
  );
  const r8 = await broker.eval(
    'await agent("pi/x", "t", { bogus: 10n }).catch(e => e.code + "|" + e.message)',
  );
  assert.equal(
    r8.result,
    'SCRIPT_VALIDATION_ERROR|agent options: unknown option "bogus" (valid options: schema, cwd, configOptions, mode)',
    'a bigint value cannot bypass the unknown-key schema error before host admission validation',
  );
  assert.equal(runner.sessions.length, 0, 'no invalid option bag reaches backend dispatch');
  await ws.dispose();
});

test('steer options: undefined promptMeta is absent and dispatches; an undefined unknown key still rejects', async () => {
  const { ws, broker, runner } = await setup();
  await dispatchAgent(broker, runner);
  runner.last().completeTurn('done');
  await tick();
  await broker.pump();

  const rejected = await broker.eval(
    'await pi.steer("redirect", { bogus: undefined }).catch(e => e.code + "|" + e.message)',
  );
  assert.equal(
    rejected.result,
    'SCRIPT_VALIDATION_ERROR|steer options: unknown option "bogus"',
    'an undefined value cannot make an unknown steer key disappear before host admission validation',
  );
  assert.equal(runner.last().prompts.length, 0, 'the invalid steer options do not start a turn');
  assert.equal(runner.last().steers.length, 0, 'the invalid steer options do not reach live steering');

  const accepted = await broker.eval('pi.followUp("next", { promptMeta: undefined }); "started"');
  assert.equal(accepted.result, 'started', 'undefined promptMeta is admitted as an absent known option');
  await tick();
  assert.equal(runner.last().prompts.length, 1, 'the followUp dispatches a new turn');
  assert.equal(runner.last().prompts[0].content, 'next');

  runner.last().completeTurn('follow-up result');
  await tick();
  await broker.pump();
  await ws.dispose();
});

test('§4.1 admission validation: an unknown backend segment rejects SYNCHRONOUSLY, naming the segment and enumerating the known backends — never a silent route to the default backend', async () => {
  const runner = new FakeRunner();
  runner.extraBackends = ['browser'];
  const { ws, broker } = await setup({ runner });
  const unknown = await broker.eval('await agent("watson/deep-v4", "t").catch(e => e.message)');
  assert.equal(
    unknown.result,
    'unknown backend "watson" in model spec "watson/deep-v4" (known backends: browser, claude, codex, opencode, pi)',
  );
  assert.equal(runner.sessions.length, 0, 'nothing was spawned');
  // A registered custom backend joins the known vocabulary.
  const custom = await broker.eval('await agent("browser/x", "t").catch(e => e.message)');
  assert.equal(custom.result, undefined);
  await tick();
  assert.equal(runner.sessions.length, 1, 'the custom backend dispatched');
  await ws.dispose();
});

test('§4.1 admission validation: configOptions keys validate against the resolved backend\'s known vocabulary where it is knowable; the [C]5 fallback names the offending key when the vocabulary is dynamic', async () => {
  const { ws, broker, runner } = await setup();
  // Knowable vocabulary (the runner seam publishes it): a typo'd key
  // fails in milliseconds, naming the key and the valid alternatives.
  runner.staticConfigOptions = { pi: ['thinkingLevel', 'effort'] };
  const typo = await broker.eval('await agent("pi/x", "t", { configOptions: { thinkinglevel: "high" } }).catch(e => e.message)');
  assert.equal(
    typo.result,
    'configOptions: unknown option "thinkinglevel" for backend "pi" (known options: thinkingLevel, effort)',
  );
  assert.equal(runner.sessions.length, 0, 'nothing was spawned');
  // Dynamic vocabulary (the seam returns undefined): admitted, and the
  // late failure names the offending key.
  runner.staticConfigOptions = {};
  runner.failConfigKeys = new Set(['thinkinglevel']);
  const late = await broker.eval('const p = await agent("pi/x", "t", { configOptions: { thinkinglevel: "high" } }).catch(e => e.name + ": " + e.message); console.log("got", p); "done"');
  assert.equal(late.result, undefined, 'the late rejection arrives after the eval suspended');
  await tick();
  await broker.pump();
  const probe = await broker.eval('"probe"');
  assert.ok(
    output(probe).some((line) => line === 'got ConfigOptionsError: backend pi rejected the call\'s configOptions — offending key "thinkinglevel" (backend error: invalid config option)'),
    output(probe).join('\n'),
  );
  // Multiple dynamic keys still identify the ACTUAL rejected key. The
  // accepted sibling must not be reported as merely one of several
  // candidates (the round-4 review repro: { good: true, bad: true }
  // rendered "offending key among: good, bad").
  runner.failConfigKeys = new Set(['bad']);
  const multi = await broker.eval(
    'const m = await agent("pi/x", "t", { configOptions: { good: true, bad: true } }).catch(e => e.name + ": " + e.message); console.log("multi", m); "done"',
  );
  assert.equal(multi.result, undefined);
  await tick();
  await broker.pump();
  const multiProbe = await broker.eval('"probe"');
  const multiLine = output(multiProbe).find((line) => line.startsWith('multi ConfigOptionsError'));
  assert.ok(multiLine !== undefined, output(multiProbe).join('\n'));
  assert.ok(multiLine.includes('offending key "bad"'), multiLine);
  assert.ok(!multiLine.includes('among'), multiLine);
  assert.ok(!multiLine.includes('"good"'), `the accepted key is not accused: ${multiLine}`);
  await ws.dispose();
});

test('§4.1 [C]5: a multi-key late configOptions error whose backend message NAMES AN ACCEPTED SIBLING still isolates and names the actual rejected key — the message hit never skips the prefix probes', async () => {
  const { ws, broker, runner } = await setup();
  // Dynamic vocabulary: admitted. The backend rejects `bad`, and its
  // own late error names the ACCEPTED sibling `good` while omitting
  // the rejected key — the round-6 review repro: { good: true,
  // bad: true } + "accepted option good; another config option is
  // invalid" emitted that vague message verbatim because ANY submitted
  // key appearing in the message short-circuited the isolation.
  runner.failConfigKeys = new Set(['bad']);
  runner.failConfigMessage = 'accepted option good; another config option is invalid';
  const late = await broker.eval(
    'const m = await agent("pi/x", "t", { configOptions: { good: true, bad: true } }).catch(e => e.name + ": " + e.message); console.log("got", m); "done"',
  );
  assert.equal(late.result, undefined, 'the late rejection arrives after the eval suspended');
  await tick();
  await broker.pump();
  const probe = await broker.eval('"probe"');
  const line = output(probe).find((l) => l.startsWith('got ConfigOptionsError'));
  assert.ok(line !== undefined, output(probe).join('\n'));
  assert.ok(line.includes('offending key "bad"'), `the actual rejected key is named, never the vague backend message alone: ${line}`);
  assert.ok(!line.includes('offending key "good"'), `the accepted sibling is never accused: ${line}`);
  assert.ok(!line.includes('among'), line);
  // The backend's own error is still reported verbatim — but as the
  // quoted backend error inside the conforming attribution, not as the
  // whole answer.
  assert.ok(line.includes('accepted option good; another config option is invalid'), line);
  assert.ok(line.includes('backend pi'), `the late error names the resolved backend: ${line}`);
  await ws.dispose();
});

test('the structured-output schema is validated by acp-agents\' own ladder (parse → validate → re-prompt → SCHEMA_NONCOMPLIANCE)', async () => {
  const { ws, broker, runner } = await setup();
  const started = await broker.eval(
    'const p = agent("pi/x", "research", { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } }); "started"',
  );
  assert.equal(started.result, 'started');
  await tick();
  // The worker's final message is JSON: the ladder's native/prose
  // extraction validates it.
  runner.last().completeTurn('{"answer": "42"}');
  await tick();
  await broker.pump();
  const got = await broker.eval('await p');
  assert.deepEqual(got.result, "{answer: '42'}");
  await ws.dispose();
});

test('a schema miss re-prompts (the ladder), then rejects SCHEMA_NONCOMPLIANCE when exhausted', async () => {
  const { ws, broker, runner } = await setup();
  await broker.eval(
    'const p = agent("pi/x", "research", { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } }); "started"',
  );
  await tick();
  const session = runner.last();
  // First turn: unparseable prose — the ladder re-prompts (the default
  // 2 retries; the guest-visible maxSchemaRetries key is deleted with
  // the §4.1 option narrowing).
  session.completeTurn('let me think about this...');
  await tick();
  assert.equal(session.prompts.length, 1, 'one repair turn was sent');
  session.completeTurn('still not json');
  await tick();
  assert.equal(session.texts.length, 3, 'two repair turns total (the default budget)');
  session.completeTurn('still not json either');
  await tick();
  await broker.pump();
  const r = await broker.eval('await p.catch(e => e.code + "/" + e.recoverable)');
  assert.equal(r.result, 'SCHEMA_NONCOMPLIANCE/false');
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
  assert.equal(r.result, 'AGENT_EMPTY_OUTPUT/true');
  await ws.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// Exactly-once settlement
// ────────────────────────────────────────────────────────────────────────

test('exactly-once settlement: a crash between the store write and the guest settlement is healed by the next pump (record→settle→consume, both first-wins)', async () => {
  const { ws, broker, runner } = await setup();
  const r1 = await broker.eval('const p = agent("pi/x", "task"); p.then((v) => console.log("settled:", v)); "started"');
  assert.equal(r1.result, 'started');
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
  assert.equal(r2.result, 'final');
  // The continuation fired exactly once (one joined line per call).
  const settledMarkers = output(r2).filter((line) => line === 'settled: final');
  assert.equal(settledMarkers.length, 1, output(r2).join('\n'));
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
  assert.equal(r1.result, 'started');
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
  const settledLines = output(r2).filter((line) => line === 'settled: final');
  assert.equal(settledLines.length, 1, output(r2).join('\n'));
  assert.equal((await broker2.eval('await p')).result, 'final');
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

test('checkpoint round trip: raised → the §4.3 output line (PLAIN question, the double-quote fix) → answered in a later eval → settlement within that eval', async () => {
  const { ws, broker } = await setup();
  const raised = await broker.eval('const q = checkpoint("What color?"); "raised"');
  assert.deepEqual(raised.checkpoints, [{ id: 'c1', question: 'What color?' }], 'the question is plain head+tail metadata text — never a double-JSON-quoted form');
  assert.deepEqual(raised.pending, ['c1']);
  assert.ok(output(raised).some((line) => line === 'checkpoint c1: What color?'), output(raised).join('\n'));
  // The question crosses previewed/truncated — never verbatim and
  // unbounded (the retained 200-char metadata preview, §7).
  const longQ = await broker.eval('const q2 = checkpoint("a".repeat(300)); "raised"');
  assert.equal(longQ.checkpoints.length, 2);
  const longQuestion = longQ.checkpoints[1].question;
  assert.ok(longQuestion.startsWith('a'.repeat(120)), longQuestion);
  assert.ok(longQuestion.includes('chars elided'), longQuestion);
  assert.ok(!longQuestion.includes('a'.repeat(200)), 'the verbatim question never crosses unbounded');
  // The continuation rides the answer's own eval drain.
  const answered = await broker.eval('checkpoint.answer("c1", "blue"); "delivered"');
  assert.equal(answered.result, 'delivered');
  assert.deepEqual(answered.checkpoints, [{ id: 'c2', question: longQuestion }]);
  const r = await broker.eval('await q');
  assert.equal(r.result, 'blue');
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
  assert.ok(output(r).some((line) => line === 'steer-outcome injected'), output(r).join('\n'));
  await ws.dispose();
});

test('steering WITHOUT the extension: a turn in flight queues for next-turn delivery and resolves "queued" immediately; the queued content becomes the next turn', async () => {
  const { ws, broker, runner } = await setup();
  runner.supportsSteering = false; // negotiated at initialize
  await dispatchAgent(broker, runner);
  // No wire call, no suspension: the honest immediate outcome is
  // "queued" — accepted for next-turn delivery.
  const queued = await broker.eval('const o = await pi.steer("go deeper"); "outcome:" + o');
  assert.equal(queued.result, 'outcome:queued');
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

test('§4.2: followUp/steer on an idle session mint a NEW turn with its own call id and resolve with the TURN\'S ANSWER (never the startedNewTurn token) — with and without the extension', async () => {
  const { ws, broker, runner } = await setup();
  await dispatchAgent(broker, runner);
  runner.last().completeTurn('done');
  await tick();
  await broker.pump();
  // Idle + extension backend.
  const withExt = await broker.eval('const o = await pi.steer("more"); console.log("outcome", o); "done"');
  assert.equal(withExt.result, undefined, 'a new turn is in flight — the steer suspends until it settles');
  await tick();
  assert.equal(runner.last().prompts.length, 1, 'the followUp turn is in flight');
  assert.equal(runner.last().prompts[0].content, 'more');
  // The turn is ADDRESSABLE: it carries its own call id, listed in
  // agents() while running.
  const liveAgents = broker.liveAgents();
  assert.ok(liveAgents.some((a) => a.callId === 'c2' && a.state === 'running'), `liveAgents: ${JSON.stringify(liveAgents)}`);
  runner.last().completeTurn('more results');
  await tick();
  await broker.pump();
  // The steer settled with the TURN'S ANSWER — never the bare
  // 'startedNewTurn' token, never a discarded turn.
  const steerRecord1 = broker.store().all().find((r) => r.kind === 'steer')!;
  assert.equal(steerRecord1.completion!.value, 'more results');
  const probe1 = await broker.eval('"probe"');
  assert.ok(output(probe1).some((line) => line === 'outcome more results'), output(probe1).join('\n'));
  // followUp and steer are aliases on idle sessions (the §4.2 [C]6
  // alias): followUp gets the same answer semantics.
  const alias = await broker.eval('const o2 = await pi.followUp("even more"); console.log("outcome", o2); "done"');
  assert.equal(alias.result, undefined);
  await tick();
  runner.last().completeTurn('even more results');
  await tick();
  await broker.pump();
  const steerRecords = broker.store().all().filter((r) => r.kind === 'steer');
  assert.equal(steerRecords.length, 2);
  assert.equal(steerRecords[1].completion!.value, 'even more results');
  await ws.dispose();
});

test('§4.2: a failed followUp turn rejects the steer call with the attributed error (call id + resolved backend)', async () => {
  const { ws, broker, runner } = await setup();
  await dispatchAgent(broker, runner);
  runner.last().completeTurn('done');
  await tick();
  await broker.pump();
  const evaled = await broker.eval('const o = await pi.followUp("do more").catch(e => e.message + "|" + e.replCallId + "|" + e.replBackend); console.log("got", o); "done"');
  assert.equal(evaled.result, undefined, 'the followUp suspends until its turn settles');
  await tick();
  runner.last().failTurn(new Error('backend exploded'));
  await tick();
  await broker.pump();
  const probe = await broker.eval('"probe"');
  assert.ok(output(probe).some((line) => line === 'got backend exploded|c2|pi'), output(probe).join('\n'));
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
  assert.ok(output(r).some((line) => line === 'steer-outcome failed'), output(r).join('\n'));
  await ws.dispose();
});

test('a steer in the same eval as the dispatch (the call is still opening) queues for next-turn delivery', async () => {
  const { ws, broker, runner } = await setup();
  const r = await broker.eval('const pi = agent("pi/x", "task"); const o = await pi.steer("same eval"); "outcome:" + o');
  assert.equal(r.result, 'outcome:queued', 'the steer queued while the session was still opening');
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
  assert.ok(output(r).some((line) => line === 'cancel-outcome cancelled'), output(r).join('\n'));
  // The call itself rejects with the machine-readable cancellation —
  // and the rejection is RECOVERABLE (review regression: it used to be
  // recoverable: false, which the guest combinators treat as a halt
  // signal — cancelling one worker then aborted the surrounding
  // parallel()/pipeline()). One call's cancellation must never abort
  // the orchestration owning it.
  const call = await broker.eval('await pi.catch((e) => e.code + "/" + e.recoverable)');
  assert.equal(call.result, 'AGENT_CANCELLED/true');
  assert.equal(runner.last().cancelled, 1, 'a second cancel of the idle session is a no-op');
  const idle = await broker.eval('await pi.cancel()');
  assert.equal(idle.result, 'idle');
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

test('§4.1: dispatches above the concurrency cap QUEUE in dispatch order for the next free slot — never a rejection', async () => {
  const { ws, broker, runner } = await setup({ maxConcurrentAgents: 2 });
  // Two calls admitted; the third and fourth QUEUE (their guest
  // promises stay pending — the natural `parallel(items.map(...))`
  // idiom never loses work).
  const queued = await broker.eval('const a = agent("pi/x", "a"); const b = agent("pi/x", "b"); const c = agent("pi/x", "c"); const d = agent("pi/x", "d"); "started"');
  assert.equal(queued.result, 'started');
  assert.equal(runner.sessions.length, 2, 'only two sessions were opened');
  assert.deepEqual(queued.pending, ['c1', 'c2', 'c3', 'c4'], 'the queued dispatches stay pending in dispatch order');
  assert.equal(broker.store().lookup('c3'), undefined, 'queued dispatches get their store record at dispatch time — nothing was refused');
  // Settle c1: its slot frees and the QUEUE head (c3) dispatches first.
  await tick();
  runner.sessions[0].completeTurn('a done');
  await tick();
  await broker.pump();
  await tick();
  assert.equal(runner.sessions.length, 3, 'the queue head dispatched');
  assert.equal(runner.sessions[2].openedWith.model, 'pi/x');
  assert.equal(runner.sessions[2].texts[0], 'c', 'dispatch order preserved');
  // Settle c2: c4 dispatches next (FIFO).
  runner.sessions[1].completeTurn('b done');
  await tick();
  await broker.pump();
  await tick();
  assert.equal(runner.sessions.length, 4);
  assert.equal(runner.sessions[3].texts[0], 'd');
  // All four resolve with their answers.
  runner.sessions[2].completeTurn('c done');
  runner.sessions[3].completeTurn('d done');
  await tick();
  await broker.pump();
  const got = await broker.eval('[await a, await b, await c, await d].join(",")');
  assert.equal(got.result, 'a done,b done,c done,d done');
  await ws.dispose();
});

test('§4.2: the interrupt cancels a QUEUED dispatch by its addressable id (AGENT_CANCELLED, recorded durably)', async () => {
  const { ws, broker, runner } = await setup({ maxConcurrentAgents: 1 });
  await broker.eval('const a = agent("pi/x", "a"); const b = agent("pi/x", "b"); "started"');
  assert.deepEqual(broker.workspace.surface()!.pending().map((e) => e.id), ['c1', 'c2']);
  const outcome = await broker.cancelCall('c2');
  assert.equal(outcome, 'cancelled');
  const r = await broker.eval('await b.catch((e) => e.code + "/" + e.recoverable)');
  assert.equal(r.result, 'AGENT_CANCELLED/true');
  assert.equal(broker.store().lookup('c2')!.completion!.outcome, 'reject');
  assert.equal(runner.sessions.length, 1, 'the queued call never dispatched');
  await ws.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// Rendering
// ────────────────────────────────────────────────────────────────────────

test('trap-free result rendering: accessor properties render as (…) and never fire; Object.prototype.value pollution cannot hijack the result', async () => {
  const { ws, broker } = await setup();
  // An accessor-valued completion renders the accessor marker — the
  // getter never runs.
  const accessor = await broker.eval('let fires = 0; const o = { get x() { fires++; return 1; } }; o');
  assert.equal(accessor.result, '{x: (…)}');
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

test('output lines are the §4.4 one-line reprs (one joined line per console.* call, levels prefixed); §7: NO output caps — output above the DELETED ceilings ships whole', async () => {
  const { ws, broker } = await setup();
  const r = await broker.eval('console.log({ a: 1 }, "text"); console.error("boom"); "done"');
  assert.equal(output(r)[0], '{a: 1} text');
  assert.equal(output(r)[1], 'error: boom');
  assert.equal(r.kind, 'value');
  // §7: the engine applies NO caps to guest output — the Python
  // posture (an agent CAN flood its own context). A flood ABOVE BOTH
  // deleted ceilings — 4500 lines, >50 KB of bytes (the v1 caps:
  // 4000 lines / 50 000 bytes — now deleted with the cap apparatus)
  // ships verbatim. Reintroducing the caps would truncate this flood;
  // the assertions below must stay green.
  const big = await broker.eval('for (let i = 0; i < 4500; i++) console.log("line", i, "padding", "x".repeat(20)); "done"');
  assert.equal(big.output.length, 4500);
  assert.equal(output(big)[4499], 'line 4499 padding xxxxxxxxxxxxxxxxxxxx');
  assert.ok(
    big.output.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0) > 50_000,
    'the flood exceeds the deleted byte cap',
  );
  // A DIRECT console string above the deleted 49 488-char emission
  // budget ships WHOLE (no upper bound — the Python posture).
  const whole = 'w'.repeat(60_000);
  const direct = await broker.eval(`console.log(${JSON.stringify(whole)}); "done"`);
  assert.equal(output(direct)[0], whole, 'a 60 000-char direct console string ships whole');
  // A string COMPLETION value above the same deleted budget renders
  // whole too (§4.4: direct strings print whole — no upper bound).
  const resultWhole = await broker.eval(`"r".repeat(60000)`);
  assert.equal(resultWhole.result, 'r'.repeat(60_000), 'a 60 000-char string completion value renders whole');
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
  assert.equal(r.result, 'stored-first');
  assert.equal(broker.store().lookup('c1')!.completion!.value, 'stored-first');
  assert.equal(broker.store().lookup('c1')!.completion!.outcome, 'resolve');
  await ws.dispose();
});

test('review 1b: the cap is absolute for follow-up turns — an idle-session steer under cap pressure QUEUES with the §4.2 answer semantics and starts only when a slot frees', async () => {
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
  // steer QUEUES for the next free slot — and, per the §4.2 answer
  // semantics, its promise stays pending until the delivery turn runs
  // (never the bare 'queued' token for an idle-session followUp).
  const steered = await broker.eval('const o = await b.steer("more"); console.log("outcome", o); "done"');
  assert.equal(steered.result, undefined, 'the followUp suspends until its queued delivery runs');
  assert.deepEqual(steered.pending, ['c3', 'c4'], 'c4 (the queued followUp) stays pending');
  await tick();
  assert.equal(bSession.prompts.length, 0, 'no follow-up turn started under cap pressure');
  // The queued turn is VISIBLE while pending: minted at enqueue, listed
  // in agents() with the honest `queued` state (the review probe: the
  // pending id was absent from agents() before its delivery started).
  const queuedAgents = broker.liveAgents();
  assert.ok(
    queuedAgents.some((a) => a.callId === 'c4' && a.state === 'queued' && a.task === 'more'),
    `the queued followUp turn is addressable before it starts: ${JSON.stringify(queuedAgents)}`,
  );
  // c3 settles; its slot frees; the queued follow-up starts its turn —
  // and settles with the TURN'S ANSWER.
  runner.sessions[2].completeTurn('c done');
  await tick();
  await broker.pump();
  await tick();
  assert.equal(bSession.prompts.length, 1, 'the queued follow-up started once a slot freed');
  assert.equal(bSession.prompts[0].content, 'more');
  bSession.completeTurn('more results');
  await tick();
  await broker.pump();
  const probe = await broker.eval('"probe"');
  assert.ok(output(probe).some((line) => line === 'outcome more results'), output(probe).join('\n'));
  assert.equal(broker.store().lookup('c4')!.completion!.value, 'more results');
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
  assert.equal(queued.result, 'queued');
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
  assert.equal(r1.result, 'outcome:queued');
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
  assert.equal(ok.result, 'delivered');
  const r = await broker.eval('await q');
  assert.equal(r.result, 'blue');
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
  // At the ceiling: six sessions open, the seventh dispatch QUEUES for
  // the next free slot (the §4.1 rule — never a rejection).
  const { ws: ws3, broker: broker3, runner: runner3 } = await setup();
  const r = await broker3.eval('for (let i = 0; i < 7; i++) agent("pi/x", "t" + i); "started"');
  assert.equal(r.result, 'started');
  await tick();
  assert.equal(runner3.sessions.length, 6, 'six sessions opened — never seven at once');
  assert.deepEqual(r.pending.length, 7, 'the seventh stays pending (queued)');
  // Settle one: the queued seventh dispatches.
  runner3.sessions[0].completeTurn('done');
  await tick();
  await broker3.pump();
  await tick();
  assert.equal(runner3.sessions.length, 7, 'the queued dispatch started once a slot freed');
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
  assert.equal(admitted.result, 'started', 'the second dispatch was admitted after the failed open');
  await tick();
  assert.equal(runner.sessions.length, 1);
  await ws.dispose();
});

test('review 7: same-eval steers of a call whose session never opens are dropped with the documented warning (outcome visibility)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  runner.failNextOpens = 1;
  const r1 = await broker.eval('const pi = agent("pi/x", "task"); const o = await pi.steer("same eval"); "outcome:" + o');
  assert.equal(r1.result, 'outcome:queued');
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
  // the ids it settled before the drain failed (review regression:
  // completed used to come back empty). §6.2: the drain failure itself
  // leaves the eval result surface — it is RETAINED under
  // workspace().diagnostics, never rendered as an output line.
  const r = await broker.eval('"probe"');
  assert.deepEqual(r.completed, ['c1'], 'the settled id survives the drain failure');
  assert.ok(
    output(r).every((l) => !l.includes('interrupted') && !l.includes('Job execution error')),
    `the drain failure left the surface: ${output(r).join('\n')}`,
  );
  const diag = await broker.eval('workspace().diagnostics.drainError === null ? "none" : workspace().diagnostics.drainError.message');
  assert.ok(
    String(diag.result ?? '').includes('interrupted') || String(diag.result ?? '').includes('Job execution error'),
    `the failure is retained in diagnostics: ${diag.result}`,
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

test('review 9: verify/judgePanel reviewers route through the RUNNER\'S DEFAULT BACKEND id — a real registered segment, never a validation bypass', async () => {
  const { ws, broker, runner } = await setup();
  // verify() resolves its reviewers through '__host_default_backend' (no
  // per-call model in the DSL options) — the fake's default backend id.
  await broker.eval('const v = verify("some claim", { reviewers: 2 }); "started"');
  await tick();
  assert.equal(runner.openedWith.length, 2);
  assert.ok(
    runner.openedWith.every((o) => o.model === 'claude'),
    'the reviewers carry the REAL default backend id (admission-validated like any agent() call)',
  );
  for (const session of runner.sessions) session.completeTurn('{"real": true, "reason": "ok"}');
  await tick();
  await broker.pump();
  const v = await broker.eval('await v');
  assert.equal(v.result, '{real: true, realCount: 2, total: 2, votes: [{…}, {…}]}');
  // judgePanel() graders route the same way.
  await broker.eval('const jp = judgePanel(["a", "b"], { judges: 2 }); "started"');
  await tick();
  assert.equal(runner.openedWith.length, 6);
  assert.ok(runner.openedWith.slice(2).every((o) => o.model === 'claude'));
  // The deleted v1 sentinel is NOT a registered backend: a bare
  // `agent("default", …)` rejects at admission, naming the segment and
  // enumerating the known backends — never a silent route to the
  // default backend.
  const refused = await broker.eval('const m = await agent("default", "x").catch((e) => e.message); m');
  assert.equal(
    refused.result,
    'unknown backend "default" in model spec "default" (known backends: claude, codex, opencode, pi)',
  );
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

test('review round 3: the eval result\'s pending list reports the WHOLE guest registry — 300 parked checkpoints list all 300 ids, dense and in order (phase-E review round 3: the trap-free surface read capped arrays at 256 elements and its [ArrayTruncated] marker leaked into the id list as an undefined hole — the structured tool output\'s pending field silently truncated)', async () => {
  const { ws, broker } = await setup();
  const r = await broker.eval('for (let i = 0; i < 300; i++) checkpoint("q-" + i); "asked"');
  assert.equal(r.pending.length, 300, 'every pending call id is listed');
  assert.equal(r.pending[0], 'c1');
  assert.equal(r.pending[255], 'c256');
  assert.equal(r.pending[256], 'c257', 'no cap truncation at the 256th entry');
  assert.equal(r.pending[299], 'c300');
  assert.ok(r.pending.every((id, index) => id === `c${index + 1}`), 'dense, in registry order, no holes');
  assert.equal(r.pending.length, r.checkpoints.length);
  await ws.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// The eval-plane redesign surface (§4.4 `_`, §4.5 workspace()/agents()/
// reset(), §4.6 error rendering, §4.7 sleep)
// ────────────────────────────────────────────────────────────────────────

test('§4.4: `_` holds the previous eval\'s completion value (IPython-style) — the sole result-history global; an error leaves it unchanged', async () => {
  const { ws, broker } = await setup();
  await broker.eval('1 + 1');
  const second = await broker.eval('_ * 10');
  assert.equal(second.result, '20');
  // `_` advances with every resolved eval (IPython semantics).
  const third = await broker.eval('({ tagged: _ })');
  assert.equal(third.result, '{tagged: 20}');
  // An error does not move `_` (IPython behavior).
  await broker.eval('throw new Error("no")');
  const afterError = await broker.eval('_');
  assert.equal(afterError.result, '{tagged: 20}', 'the failed eval left `_` unchanged');
  // `_` is an ordinary writable global: bindings are the memory.
  await broker.eval('_ = "mine"');
  assert.equal((await broker.eval('_')).result, 'mine');
  await ws.dispose();
});

test('§4.6: an uncaught eval error renders name + message + the guest stack\'s top frames with line numbers in the submitted code', async () => {
  const { ws, broker } = await setup();
  const r = await broker.eval('const boom = () => { throw new TypeError("bad shape"); };\nboom();');
  assert.equal(r.result, undefined);
  const line = output(r).find((l) => l.startsWith('TypeError'));
  assert.ok(line !== undefined, output(r).join('\n'));
  assert.ok(line.includes('TypeError: bad shape'), line);
  // The stack's top frames carry LINE NUMBERS in the submitted code
  // (the eval's filename is the VM default `<repl>`).
  assert.match(line, /at boom \(<repl>:1:\d+\)/, line);
  assert.match(line, /<repl>:2:\d+/, line);
  const primitive = await broker.eval('const marker = 1;\nthrow "primitive boom";');
  const primitiveLine = output(primitive).find((l) => l.startsWith('Error: primitive boom'));
  assert.ok(primitiveLine !== undefined, output(primitive).join('\n'));
  assert.match(primitiveLine, /<repl>:2:\d+/, primitiveLine);
  await ws.dispose();
});

test('§4.6: an uncaught error from a subagent call names the call id and the resolved backend', async () => {
  const { ws, broker, runner } = await setup();
  // Await a call that rejects; the rejection is uncaught in the eval.
  const r = await broker.eval('await agent("pi/x", "research"); "never"');
  assert.equal(r.result, undefined);
  await tick();
  runner.last().failTurn(new Error('research failed'));
  await tick();
  await broker.pump();
  const probe = await broker.eval('"probe"');
  const line = output(probe).find((l) => l.includes('Error: research failed'));
  assert.ok(line !== undefined, output(probe).join('\n'));
  assert.ok(line.includes('(call c1 on backend pi)'), line);
  // [C]10: the late rejection rendering ALSO carries the guest stack's
  // frames with LINE NUMBERS in the submitted code (the review probe
  // reproduced only the bare name/message line).
  assert.match(line, /<repl>:1:\d+/, line);
  await ws.dispose();
});

test('§4.7: sleep(ms) is a guest helper over a HOST-side timer — the eval suspends and its continuation resumes at the next settlement drain', async () => {
  const { ws, broker } = await setup();
  const started = Date.now();
  const r = await broker.eval('const t0 = Date.now(); await sleep(30); console.log("elapsed", Date.now() - t0); "slept"');
  assert.equal(r.result, undefined, 'the eval suspended on the sleep');
  // The host timer settles within the window; the pump drains the
  // continuation.
  await new Promise((resolve) => setTimeout(resolve, 80));
  await broker.pump();
  const probe = await broker.eval('"probe"');
  const line = output(probe).find((l) => l.startsWith('elapsed'));
  assert.ok(line !== undefined, output(probe).join('\n'));
  const elapsed = Number(/elapsed (\d+)/.exec(line)![1]);
  assert.ok(elapsed >= 20 && elapsed < 5000, `elapsed ${elapsed}`);
  assert.ok(Date.now() - started >= 20, 'wall clock advanced');
  await ws.dispose();
});

test('§4.5: workspace() returns the plain-value shape with the honest failed status; agents() lists live agents incl. addressable followUp turns', async () => {
  const { ws, broker, runner } = await setup();
  // c1 fails; c2 succeeds. Both are agent-handle bindings.
  await broker.eval('const boom = agent("pi/x", "boom"); const ok = agent("pi/x", "ok"); "started"');
  await tick();
  runner.sessions[0].failTurn(new Error('nope'));
  await tick();
  await broker.pump();
  runner.sessions[1].completeTurn('fine');
  await tick();
  await broker.pump();
  const w = await broker.eval('const w = workspace(); w.bindings.filter((b) => b.name === "boom" || b.name === "ok").map((b) => b.name + ":" + (b.status ?? "-")).join(",")');
  assert.equal(w.result, 'boom:failed,ok:settled', 'the honest failed status for the rejected handle call');
  const shape = await broker.eval('(() => { const w = workspace(); return JSON.stringify({ keys: Object.keys(w).sort(), diag: Object.keys(w.diagnostics).sort(), empty: w.inFlight.length === 0 }); })()');
  assert.deepEqual(JSON.parse(shape.result!), { keys: ['bindings', 'checkpoints', 'diagnostics', 'inFlight'], diag: ['childrenClosed', 'drainError', 'reconcile'], empty: true });
  // agents(): a followUp turn gets its own addressable entry.
  await broker.eval('const o = await ok.followUp("more"); console.log("followup", o); "done"');
  await tick();
  const a = await broker.eval('const a = agents(); a.filter((x) => x.callId === "c3").map((x) => x.state + "|" + x.task)[0]');
  assert.equal(a.result, 'running|more');
  runner.sessions[1].completeTurn('the answer');
  await tick();
  await broker.pump();
  const after = await broker.eval('"probe"');
  assert.ok(output(after).some((l) => l === 'followup the answer'), output(after).join('\n'));
  await ws.dispose();
});

test('§4.5/§7: workspace().checkpoints keeps the retained 200-character question preview', async () => {
  const { ws, broker } = await setup();
  await broker.eval('checkpoint("q".repeat(300)); "asked"');
  const retained = broker.checkpointSummaries()[0].question;
  const guest = await broker.eval('workspace().checkpoints[0].question');
  assert.equal(guest.result, retained, 'workspace() exposes the same retained preview as checkpoint summaries');
  assert.notEqual(guest.result, 'q'.repeat(300), 'the raw question cannot bypass the metadata preview');
  await ws.dispose();
});

test('§4.5: reset() tears the workspace down after the current eval completes (the host-side effect the deleted reset action performed)', async () => {
  const { ws, broker } = await setup();
  const r = await broker.eval('console.log("bye"); reset(); "done"');
  assert.equal(r.result, 'done');
  assert.ok(output(r).includes('bye'), 'the eval that called reset() completed normally first');
  // After the eval, the workspace is gone (the VM disposed).
  assert.equal(ws.isDisposed, true, 'reset() tore the workspace down after the eval completed');
  await assert.rejects(async () => broker.eval('1 + 1'), /disposed|alive/);
  await ws.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// Review-fix regressions: `_` after a late completion, reset() after a
// suspended eval, the mid-turn steer vocabulary, followUp schema answers,
// admission-refusal attribution, and the late-rejection stack frames
// ────────────────────────────────────────────────────────────────────────

test('§4.4: `_` updates when a SUSPENDED eval completes during a pump — the settled previous eval is the previous eval', async () => {
  const { ws, broker } = await setup();
  const r = await broker.eval('await sleep(10); 42');
  assert.equal(r.result, undefined, 'the eval suspended on the sleep');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await broker.pump();
  const probe = await broker.eval('_');
  assert.equal(probe.result, '42', 'the late completion value became `_` (the review probe: undefined before the fix)');
  // An empty poll (the documented eval("") idiom) COMPLETES with
  // undefined — `_` becomes undefined: the previous eval's completion
  // value IS undefined (the review probe: `42`, then an empty eval,
  // then `_` must read undefined, never the stale 42).
  await broker.eval('"tagged"');
  await broker.eval('');
  assert.equal((await broker.eval('_')).result, 'undefined');
  // The overwrite happens for the IN-CALL undefined completion too:
  // `42`, then `undefined;` — `_` reads undefined.
  await broker.eval('42');
  await broker.eval('undefined');
  assert.equal((await broker.eval('_')).result, 'undefined');
  await ws.dispose();
});

test('§4.5: reset() in a SUSPENDED eval tears the workspace down BEFORE any later guest code — the reset-owning eval completed at the pump', async () => {
  const { ws, broker } = await setup();
  const r = await broker.eval('reset(); await sleep(50); console.log("finished"); "done-after-sleep"');
  assert.equal(r.result, undefined, 'the eval suspended on the sleep');
  assert.equal(ws.isDisposed, false, 'the workspace is ALIVE while the reset eval is still in flight');
  // The host timer fires; the next operation's pump runs the continuation
  // to completion. The reset-owning eval COMPLETED — its teardown is owed
  // BEFORE the new eval's submitted code runs: the new eval rejects on
  // the disposed workspace and its code never executes (the review
  // probe: the later eval returned "probe-ran" before the disposal).
  await new Promise((resolve) => setTimeout(resolve, 90));
  await assert.rejects(async () => broker.eval('"probe-ran"'), /disposed/);
  assert.equal(ws.isDisposed, true, 'the teardown ran before the later eval\'s code');
  await ws.dispose();
});

test('§4.2: a MID-TURN steer resolves only the delivery-outcome vocabulary — a backend startedNewTurn maps to queued, never the bare token', async () => {
  const { ws, broker, runner } = await setup();
  await dispatchAgent(broker, runner);
  // The founding turn is in flight: the steer is a live mid-turn
  // injection. The backend reports startedNewTurn (the injection raced
  // the turn's end) — the handle must resolve `queued`, never the token.
  await broker.eval('const o = pi.steer("redirect"); "steered"');
  await tick();
  runner.last().completeSteer('startedNewTurn');
  await tick();
  await broker.pump();
  const r = await broker.eval('await o');
  assert.equal(r.result, 'queued');
  // A live injection keeps its own outcome.
  await broker.eval('const i = pi.steer("again"); "steered"');
  await tick();
  runner.last().completeSteer('injected');
  await tick();
  await broker.pump();
  assert.equal((await broker.eval('await i')).result, 'injected');
  await ws.dispose();
});

test('§4.2: followUp on a schema handle resolves the SCHEMA-VALIDATED object — the same value semantics as agent()', async () => {
  const { ws, broker, runner } = await setup();
  await broker.eval(
    'const h = agent("pi/x", "orig", { schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } }); "started"',
  );
  await tick();
  runner.last().completeTurn('{"n": 7}');
  await tick();
  await broker.pump();
  const founding = await broker.eval('await h');
  assert.equal(founding.result, '{n: 7}');
  // The followUp turn mints its own call id and resolves with the turn's
  // SCHEMA-VALIDATED answer (not raw text).
  await broker.eval('const f = h.followUp("more"); "started"');
  await tick();
  runner.last().completeTurn('{"n": 42}');
  await tick();
  await broker.pump();
  const got = await broker.eval('await f');
  assert.equal(got.result, '{n: 42}');
  await ws.dispose();
});

test('§4.6: a synchronous admission refusal with a RESOLVED backend names the backend in the uncaught-error rendering (call id + backend)', async () => {
  const { ws, broker } = await setup();
  const r = await broker.eval('await agent("pi/x", "t", { bogus: 1 })');
  assert.equal(r.result, undefined);
  const line = output(r).find((l) => l.startsWith('WorkflowError'));
  assert.ok(line !== undefined, output(r).join('\n'));
  assert.ok(line.includes('unknown option "bogus"'), line);
  assert.ok(line.includes('(call c1 on backend pi)'), line);
  await ws.dispose();
});

test('§4.6: cancelling a QUEUED dispatch stamps the resolved backend on the rejection (call id + backend on every known-backend rejection path)', async () => {
  const { ws, broker } = await setup({ maxConcurrentAgents: 1 });
  await broker.eval('const a = agent("pi/x", "first"); "started"');
  await tick();
  // The second dispatch queues above the cap; the interrupt cancels it
  // by id — the rejection carries the call id and its resolved backend.
  await broker.eval('const q = agent("pi/y", "queued").catch((e) => e.replBackend + "/" + e.replCallId); "started"');
  const outcome = await broker.cancelCall('c2');
  assert.equal(outcome, 'cancelled');
  const r = await broker.eval('await q');
  assert.equal(r.result, 'pi/c2', 'the queued-dispatch cancellation rejection names the resolved backend');
  await ws.dispose();
});

test('§4.5: workspace().diagnostics carries the retained reconcile summary, the RETAINED drain error, and childrenClosed through both state transitions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-broker-diag-'));
  const storePath = join(dir, 'calls.jsonl');
  const store = JsonlCallStore.open(storePath);
  let interruptDrains = false;
  const { ws, broker, runner } = await setup({ store, interruptHandler: () => interruptDrains });
  // A reconcile report is retained under diagnostics.
  await broker.reconcile();
  const d1 = await broker.eval('workspace().diagnostics.reconcile === null ? "null" : typeof workspace().diagnostics.reconcile');
  assert.equal(d1.result, 'object');
  // No drain error yet; children open before the client-presence drain.
  const d2 = await broker.eval('workspace().diagnostics.drainError === null ? "null" : workspace().diagnostics.drainError.name');
  assert.equal(d2.result, 'null', 'no drain error yet');
  const closed0 = await broker.eval('workspace().diagnostics.childrenClosed');
  assert.equal(closed0.result, 'false', 'children open before the client-presence drain');
  // A FAILED settlement drain RETAINS its error under diagnostics: a
  // runaway guest continuation interrupted mid-drain (the broker-level
  // interrupt handler fires inside the pump's settlement drain) — the
  // §6.2 demotion: the failure leaves the eval result surface and
  // lives here; the pump reports it honestly and the VM stays usable.
  await broker.eval('agent("pi/x", "task").then(() => { let j = 0; while (true) j++; }); "started"');
  await tick();
  runner.last().completeTurn('done');
  await tick();
  interruptDrains = true;
  await assert.rejects(
    () => broker.pump(),
    (error: unknown) => (error as Error).name === 'DrainJobError',
    'the runaway continuation interrupts the settlement drain',
  );
  interruptDrains = false;
  const retained = await broker.eval(
    'workspace().diagnostics.drainError === null ? "null" : workspace().diagnostics.drainError.name + ":" + workspace().diagnostics.drainError.message',
  );
  assert.equal(retained.result, 'InternalError:interrupted', 'the failed settlement drain is RETAINED under diagnostics');
  // childrenClosed reflects the client-presence drain: the settled
  // session releases and the latch flips.
  const drained = await broker.drainForDisconnect(200);
  assert.equal(drained, true, 'the drain completed within its bound');
  const closed1 = await broker.eval('workspace().diagnostics.childrenClosed');
  assert.equal(closed1.result, 'true', 'childrenClosed flips after the client-presence drain');
  await broker.dispose();
  ws.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('§4.2: a QUEUED followUp turn is targetable by interrupt while it waits for a slot — AGENT_CANCELLED, dropped durably, gone from agents()', async () => {
  const { ws, broker, runner } = await setup({ maxConcurrentAgents: 1 });
  // c1 settles (idle); c2 takes the only slot.
  await broker.eval('const a = agent("pi/x", "a"); "started"');
  await tick();
  runner.sessions[0].completeTurn('a done');
  await tick();
  await broker.pump();
  await broker.eval('const busy = agent("pi/x", "busy"); "started"');
  await tick();
  // The followUp on the idle a-handle queues behind the cap (c3) — its
  // guest promise stays pending, and the turn is addressable NOW.
  const steered = await broker.eval('const o = await a.followUp("more").catch(e => e.code); console.log("outcome", o); "done"');
  assert.equal(steered.result, undefined, 'the followUp suspends until its queued delivery runs');
  await tick();
  assert.ok(broker.liveAgents().some((a) => a.callId === 'c3' && a.state === 'queued'), 'c3 is listed while queued');
  assert.equal(runner.sessions[0].prompts.length, 0, 'no turn started under cap pressure');
  // The interrupt cancels the QUEUED turn by its own id — durable drop,
  // recoverable rejection, and the turn leaves agents().
  assert.equal(await broker.cancelCall('c3'), 'cancelled');
  assert.equal(broker.store().lookup('c3')!.completion!.outcome, 'reject');
  assert.notEqual(broker.store().lookup('c3')!.droppedAtMs, null, 'the drop is recorded durably');
  const probe = await broker.eval('"probe"');
  assert.ok(output(probe).some((l) => l === 'outcome AGENT_CANCELLED'), output(probe).join('\n'));
  assert.ok(!broker.liveAgents().some((a) => a.callId === 'c3'), 'the cancelled queued turn left agents()');
  // The freed slot is NOT consumed by the cancelled turn; the session
  // stays idle with no delivery turn.
  assert.equal(runner.sessions[0].prompts.length, 0);
  await ws.dispose();
});

test('§4.6: cancelling an in-flight followUp turn renders the uncaught error WITH the call id AND the resolved backend', async () => {
  const { ws, broker, runner } = await setup();
  await dispatchAgent(broker, runner);
  runner.last().completeTurn('done');
  await tick();
  await broker.pump();
  // An UNCAUGHT await of the followUp: the cancellation rejection
  // renders through the rejection bridge in the next tool result.
  await broker.eval('const f = pi.followUp("long job"); await f; "unreachable"');
  await tick();
  assert.equal(await broker.cancelCall('c2'), 'cancelled');
  await tick();
  await broker.pump();
  const probe = await broker.eval('"probe"');
  const line = output(probe).find((l) => l.includes('followUp c2 was cancelled'));
  assert.ok(line !== undefined, output(probe).join('\n'));
  assert.ok(line.includes('(call c2 on backend pi)'), `the rendering names the call id and the resolved backend: ${line}`);
  await ws.dispose();
});

test('§4.2: a MID-TURN steer resolves EXACTLY the delivery-outcome vocabulary — an unrecognized backend outcome is constrained, never passed through', async () => {
  const { ws, broker, runner } = await setup();
  await dispatchAgent(broker, runner);
  await broker.eval('const o = pi.steer("redirect"); "steered"');
  await tick();
  // A backend resolving an outcome OUTSIDE injected/queued/failed (a
  // third-party adapter's own vocabulary): the engine constrains it to
  // the delivery-outcome vocabulary — the wire call did not reject, so
  // the content was accepted (mapped to `queued`, never the raw
  // `surprise` string).
  runner.last().completeSteer('surprise');
  await tick();
  await broker.pump();
  assert.equal((await broker.eval('await o')).result, 'queued');
  await ws.dispose();
});

test('§4.1 [C]5: the late configOptions error names the offending key EVEN WHEN the diagnostic reopen fails', async () => {
  const { ws, broker, runner } = await setup();
  // Dynamic vocabulary (the seam returns undefined): admitted. The
  // first open fails with the backend's own vague error (no key named),
  // AND the diagnostic reopen without configOptions fails too — the
  // late error must still name the offending key.
  runner.failConfigKeys = new Set(['thinkinglevel']);
  runner.failDiagnosticOpens = 1;
  const late = await broker.eval(
    'const p = await agent("pi/x", "t", { configOptions: { thinkinglevel: "high" } }).catch(e => e.name + ": " + e.message); console.log("got", p); "done"',
  );
  assert.equal(late.result, undefined, 'the late rejection arrives after the eval suspended');
  await tick();
  await broker.pump();
  const probe = await broker.eval('"probe"');
  const line = output(probe).find((l) => l.startsWith('got ConfigOptionsError'));
  assert.ok(line !== undefined, output(probe).join('\n'));
  assert.ok(line.includes('thinkinglevel'), `the late error names the offending key: ${line}`);
  assert.ok(line.includes('backend pi'), `the late error names the resolved backend: ${line}`);
  assert.ok(line.includes('invalid config option'), `the original backend error is reported: ${line}`);
  assert.ok(line.includes('diagnostic open without configOptions failed too'), `the failed diagnostic reopen is reported: ${line}`);
  await ws.dispose();
});

test('§4.2: the interrupt targets an in-flight followUp TURN by its own call id — the turn cancels and the steer rejects recoverable', async () => {
  const { ws, broker, runner } = await setup();
  await dispatchAgent(broker, runner);
  runner.last().completeTurn('done');
  await tick();
  await broker.pump();
  const evaled = await broker.eval('const o = await pi.followUp("long job").catch(e => e.code + "/" + e.recoverable); console.log("got", o); "done"');
  assert.equal(evaled.result, undefined, 'the followUp turn is in flight');
  await tick();
  assert.ok(broker.liveAgents().some((a) => a.callId === 'c2' && a.state === 'running'));
  // The interrupt (cancel by id) targets the TURN, not the founding call.
  assert.equal(await broker.cancelCall('c2'), 'cancelled');
  await tick();
  await broker.pump();
  const probe = await broker.eval('"probe"');
  assert.ok(output(probe).some((l) => l === 'got AGENT_CANCELLED/true'), output(probe).join('\n'));
  // The founding call's session stays usable (idle — the founding call
  // itself was settled long before).
  assert.equal(await broker.cancelCall('c1'), 'idle');
  await ws.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// Review-rejection regressions (eval-plane redesign, review round 3):
// guest cancellation of cap-queued dispatches, followUp addressability
// during delayed lazy re-attachment, restored answer-mode queues without
// an attached founding session, cancellation with queued answer-mode
// siblings, reset ownership racing an unrelated suspended eval, and
// verbatim long modelSpec values in agents().
// ────────────────────────────────────────────────────────────────────────

test('§4.1/§4.2: the guest handle\'s cancel() reaches a founding dispatch QUEUED above the cap — AGENT_CANCELLED, recorded durably, never a late prompt', async () => {
  const { ws, broker, runner } = await setup({ maxConcurrentAgents: 1 });
  await broker.eval('const a = agent("pi/x", "a"); const b = agent("pi/y", "b"); "started"');
  assert.equal(runner.sessions.length, 1, 'only a dispatched — b waits in the dispatch queue');
  // The handle's OWN cancel (the review probe: h.cancel() fell through
  // to `failed` while the supposedly-cancelled queued dispatch later
  // opened and prompted when a slot freed).
  const steered = await broker.eval('const o = await b.cancel(); "cancelled:" + o');
  assert.equal(steered.result, 'cancelled:cancelled', 'the handle cancel reports the honest cancelled outcome');
  const record = broker.store().lookup('c2')!;
  assert.equal(record.completion!.outcome, 'reject', 'the queued dispatch settled durably');
  assert.equal((record.completion!.value as { code?: string }).code, 'AGENT_CANCELLED');
  const got = await broker.eval('await b.catch((e) => e.code + "/" + e.recoverable)');
  assert.equal(got.result, 'AGENT_CANCELLED/true', 'the queued founding call rejects recoverable');
  // Free the slot: the cancelled queued dispatch must never open a
  // session or prompt.
  await tick();
  runner.sessions[0].completeTurn('a done');
  await tick();
  await broker.pump();
  await tick();
  assert.equal(runner.sessions.length, 1, 'the cancelled queued dispatch never dispatched');
  assert.equal(runner.sessions[0].prompts.length, 0);
  await ws.dispose();
});

test('§4.2: a followUp on a DRAINED settled handle is minted and targetable from mint time — visible in agents() and interrupt-cancelable while the lazy re-attach load is still in flight', async () => {
  const { ws, broker, runner } = await setup();
  await dispatchAgent(broker, runner);
  runner.last().completeTurn('done');
  await tick();
  await broker.pump();
  // The client-presence drain releases every child (the founding
  // session is gone — a followUp re-attaches it lazily).
  assert.equal(await broker.drainForDisconnect(200), true);
  // Park the lazy load: the turn exists while the load is in flight.
  runner.parkLoads = true;
  const evaled = await broker.eval('const o = await pi.followUp("more").catch(e => e.code); console.log("got", o); "done"');
  assert.equal(evaled.result, undefined, 'the followUp suspends until its turn answers');
  await tick();
  assert.equal(runner.parkedLoads.length, 1, 'the lazy re-attach load is parked');
  // The review probe: during the delayed load the minted call was
  // omitted from agents() and interrupt returned `none`. The turn must
  // be visible and targetable from mint time.
  const agents = broker.liveAgents();
  assert.ok(
    agents.some((a) => a.callId === 'c2' && a.state === 'opening' && a.task === 'more' && a.modelSpec === 'pi/deepseek-v4-flash-max'),
    `the minted turn is listed while the load is in flight: ${JSON.stringify(agents)}`,
  );
  assert.equal(await broker.cancelCall('c2'), 'cancelled', 'interrupt targets the loading turn');
  // The load lands: the cancelled turn must never start — it settles
  // with the recoverable AGENT_CANCELLED, dropped durably.
  const loaded = runner.releaseParkedLoad();
  await tick();
  await broker.pump();
  await tick();
  assert.equal(loaded.prompts.length, 0, 'the cancelled turn never prompted the re-attached session');
  const record = broker.store().lookup('c2')!;
  assert.equal(record.completion!.outcome, 'reject');
  assert.notEqual(record.droppedAtMs, null, 'the drop is recorded durably');
  const probe = await broker.eval('"probe"');
  assert.ok(output(probe).some((l) => l === 'got AGENT_CANCELLED'), output(probe).join('\n'));
  assert.ok(!broker.liveAgents().some((a) => a.callId === 'c2'), 'the cancelled turn left agents()');
  await ws.dispose();
});

test('restore: a cap-queued answer-mode followUp whose founding handle was already settled re-queues ADDRESSABLY — registered and interrupt-cancelable while its re-attach load is parked, and delivered with the TURN\'S ANSWER once capacity frees', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-broker-restore-queued-followup-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner, maxConcurrentAgents: 1 });
  // c1 opens + settles (idle); c2 takes the ONLY slot.
  await broker.eval('const a = agent("pi/x", "a"); "started"');
  await tick();
  runner.sessions[0].completeTurn('a done');
  await tick();
  await broker.pump();
  await broker.eval('const b = agent("pi/x", "b"); "started"');
  await tick();
  // Two followUps on the idle a-handle queue under the cap (c3, c4) —
  // their promises stay pending; the store records the queued markers.
  await broker.eval('const o3 = await a.followUp("three").catch(e => e.code); console.log("got3", o3); "done"');
  await broker.eval('const o4 = await a.followUp("four").catch(e => e.code); console.log("got4", o4); "done"');
  assert.equal(runner.sessions[0].prompts.length, 0, 'no delivery under cap pressure');
  assert.notEqual(broker.store().lookup('c3')!.queuedAtMs, null, 'the queued marker is durable');
  assert.notEqual(broker.store().lookup('c4')!.queuedAtMs, null);
  // Simulated crash: snapshot + dispose with both followUps queued.
  const snapshot = ws.snapshot();
  await broker.dispose();
  ws.dispose();
  // Restore over the same store.
  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  runner2.parkLoads = true;
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath), maxConcurrentAgents: 1 });
  // Reconcile parks on c2's re-attach load (the first parked load).
  const reconciling = broker2.reconcile();
  await tick();
  assert.equal(runner2.parkedLoads.length, 1, 'c2\'s re-attach load is parked');
  const reattachedC2 = runner2.releaseParkedLoad();
  await reconciling;
  await tick();
  // The rebuild scheduled c1's lazy re-attach (the second parked load):
  // the re-queued turns are registered with NO attached session — the
  // review probe: agents() omitted them and interrupt returned `none`.
  assert.equal(runner2.parkedLoads.length, 1, 'the founding session\'s lazy re-attach is parked');
  const agents = broker2.liveAgents();
  assert.ok(
    agents.some((a) => a.callId === 'c3' && a.state === 'opening' && a.task === 'three'),
    `the restored queued turn c3 is listed while its session re-attaches: ${JSON.stringify(agents)}`,
  );
  assert.ok(
    agents.some((a) => a.callId === 'c4' && a.state === 'opening' && a.task === 'four'),
    `the restored queued turn c4 is listed while its session re-attaches: ${JSON.stringify(agents)}`,
  );
  // Interrupt targets the queued turn while the load is parked.
  assert.equal(await broker2.cancelCall('c3'), 'cancelled');
  assert.equal(broker2.store().lookup('c3')!.completion!.outcome, 'reject');
  assert.notEqual(broker2.store().lookup('c3')!.droppedAtMs, null, 'the drop is durable');
  assert.ok(!broker2.liveAgents().some((a) => a.callId === 'c3'), 'the cancelled turn left agents()');
  // The load lands; c4 merges into the rebuilt session's queue and
  // waits for capacity (c2 still holds the only slot).
  const loadedFounding = runner2.releaseParkedLoad();
  await tick();
  assert.equal(loadedFounding.prompts.length, 0, 'no delivery while the cap is exhausted');
  assert.ok(
    broker2.liveAgents().some((a) => a.callId === 'c4' && a.state === 'queued'),
    'c4 waits attached and queued behind the cap',
  );
  // c2's re-attached loaded turn completes; its slot frees and the
  // queued followUp delivers — settling the restored guest promise
  // with the TURN'S ANSWER.
  assert.equal(reattachedC2.loadedTurns.length, 1, 'the re-attach observes the loaded turn');
  reattachedC2.loadedTurns[0].resolve({ stopReason: 'end_turn', text: 'b done' });
  await tick();
  await broker2.pump();
  await tick();
  assert.equal(loadedFounding.prompts.length, 1, 'the queued followUp started once a slot freed');
  assert.equal(loadedFounding.prompts[0].content, 'four');
  loadedFounding.completeTurn('four results');
  await tick();
  await broker2.pump();
  // The restored SUSPENDED evals resumed at their settlements: the
  // cancelled turn's continuation printed its recoverable rejection and
  // the delivered turn's continuation printed the TURN'S ANSWER (the
  // §4.2 promise semantics survive the restore).
  const probe = await broker2.eval('"probe"');
  assert.ok(output(probe).some((l) => l === 'got3 AGENT_CANCELLED'), output(probe).join('\n'));
  assert.ok(output(probe).some((l) => l === 'got4 four results'), output(probe).join('\n'));
  assert.equal(broker2.store().lookup('c4')!.completion!.value, 'four results', 'the delivered turn recorded its answer');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('§4.2: cancelling one in-flight followUp turn never discards its QUEUED answer-mode siblings — each settles with an explicit recoverable rejection (recorded + guest-settled)', async () => {
  const { ws, broker, runner } = await setup({ maxConcurrentAgents: 1 });
  // c1 opens + settles (idle); c2 takes the only slot.
  await broker.eval('const a = agent("pi/x", "a"); "started"');
  await tick();
  runner.sessions[0].completeTurn('a done');
  await tick();
  await broker.pump();
  await broker.eval('const busy = agent("pi/x", "busy"); "started"');
  await tick();
  // Two followUps queue behind the cap (c3, c4 — both answer-mode).
  await broker.eval('const o3 = await a.followUp("three").catch(e => e.code); console.log("got3", o3); "done"');
  await broker.eval('const o4 = await a.followUp("four").catch(e => e.code); console.log("got4", o4); "done"');
  await tick();
  assert.ok(broker.liveAgents().some((a) => a.callId === 'c3' && a.state === 'queued'));
  assert.ok(broker.liveAgents().some((a) => a.callId === 'c4' && a.state === 'queued'));
  // c2 settles: the kick starts c3's delivery turn (in flight).
  runner.sessions[1].completeTurn('busy done');
  await tick();
  await broker.pump();
  await tick();
  assert.equal(runner.sessions[0].prompts.length, 1, 'the first queued followUp is delivering');
  // The interrupt cancels the IN-FLIGHT turn c3; the queue drop must
  // settle the sibling c4 explicitly (the review probe: c4 vanished
  // from agents() with completion: null and a pending guest promise).
  assert.equal(await broker.cancelCall('c3'), 'cancelled');
  await tick();
  await broker.pump();
  const c4 = broker.store().lookup('c4')!;
  assert.notEqual(c4.completion, null, 'the sibling turn has a recorded completion');
  assert.equal(c4.completion!.outcome, 'reject');
  assert.equal((c4.completion!.value as { code?: string }).code, 'AGENT_CANCELLED');
  assert.notEqual(c4.droppedAtMs, null, 'the sibling drop is durable');
  assert.ok(!broker.liveAgents().some((a) => a.callId === 'c4'), 'the dropped sibling left agents()');
  const probe = await broker.eval('"probe"');
  assert.ok(output(probe).some((l) => l === 'got3 AGENT_CANCELLED'), output(probe).join('\n'));
  assert.ok(output(probe).some((l) => l === 'got4 AGENT_CANCELLED'), output(probe).join('\n'));
  await ws.dispose();
});

test('§4.5: reset() ownership is the reset-calling eval ALONE — an unrelated suspended eval never gates the teardown (and a continuation-called reset() attributes through the continuation token)', async () => {
  const { ws, broker } = await setup();
  // The reset-owning eval suspends on a sleep; an UNRELATED eval
  // suspends on a longer one. The review probe: the unrelated eval's
  // suspension joined the owning set, so completing the reset-calling
  // eval left the workspace running guest code while the unrelated
  // eval stayed suspended.
  const resetEval = await broker.eval('reset(); await sleep(50); console.log("reset-finished"); "reset-result"');
  assert.equal(resetEval.result, undefined, 'the reset-owning eval suspended');
  const unrelated = await broker.eval('await sleep(500); console.log("unrelated-finished"); "unrelated-result"');
  assert.equal(unrelated.result, undefined, 'the unrelated eval suspended');
  assert.equal(ws.isDisposed, false, 'the workspace is alive while the reset eval is in flight');
  // The reset-owning eval's sleep fires; the unrelated eval is STILL
  // suspended. The teardown is owed the moment the reset-calling eval
  // completes — the next eval must reject on the disposed workspace
  // (never run its code, never wait for the unrelated eval).
  await new Promise((resolve) => setTimeout(resolve, 90));
  await assert.rejects(async () => broker.eval('"probe-ran"'), /disposed/);
  assert.equal(ws.isDisposed, true, 'the teardown depended only on the reset-calling eval');
  await ws.dispose();
});

test('§4.5: reset() called from a RESUMED continuation (`await sleep(…); reset()`) attributes to the reset-calling eval — the teardown runs at the pump that completes it', async () => {
  const { ws, broker } = await setup();
  const r = await broker.eval('await sleep(30); reset(); console.log("continuation-reset"); "done-after-reset"');
  assert.equal(r.result, undefined, 'the eval suspended on the sleep');
  assert.equal(ws.isDisposed, false, 'the workspace is alive while the eval is in flight');
  await new Promise((resolve) => setTimeout(resolve, 80));
  // The pump runs the continuation (which calls reset()); the sweep
  // releases the completed wrapper and the serialized-op post-hook
  // tears the workspace down — before any later guest code.
  await broker.pump();
  assert.equal(ws.isDisposed, true, 'the continuation-called reset() tore the workspace down at the completing pump');
  await assert.rejects(async () => broker.eval('1 + 1'), /disposed|alive/);
  await ws.dispose();
});

test('§4.5: reset() after an immediately-resolved local await (the eval\'s OWN drain) is still THIS eval\'s request — the teardown follows that eval\'s completion', async () => {
  const { ws, broker } = await setup();
  // The continuation of `await Promise.resolve(0)` runs in the eval's
  // OWN drain phase — the reset() call there belongs to THIS eval (the
  // per-eval flag, discriminated by the continuation token), never to
  // whichever eval's token the lease mirror held last.
  const r = await broker.eval('await Promise.resolve(0); reset(); "done-after-local-await"');
  assert.equal(r.result, 'done-after-local-await');
  assert.equal(ws.isDisposed, true, 'the own-drain reset() tore the workspace down after the eval completed');
  await assert.rejects(async () => broker.eval('1 + 1'), /disposed|alive/);
  await ws.dispose();
});

test('§4.5/§7: agents() carries the modelSpec VERBATIM — no 200-char head/tail cap on the spec (session and followUp-turn entries alike)', async () => {
  const { ws, broker, runner } = await setup();
  const spec = 'pi/' + 'x'.repeat(500);
  await broker.eval(`const h = agent(${JSON.stringify(spec)}, "task"); "started"`);
  await tick();
  const sessionEntry = await broker.eval(
    `(() => { const a = agents()[0]; return a.modelSpec.length + ":" + a.modelSpec.slice(0, 3) + ":" + a.modelSpec.slice(-3); })()`,
  );
  assert.equal(sessionEntry.result, '503:pi/:xxx', 'the session entry carries the whole 503-char spec');
  // The followUp-turn entry renders the founding session's spec
  // verbatim too (the review probe read a 200-char preview back).
  runner.last().completeTurn('done');
  await tick();
  await broker.pump();
  await broker.eval('const f = h.followUp("more"); "started"');
  await tick();
  const turnEntry = await broker.eval(
    `(() => { const t = agents().find((a) => a.callId === "c2"); return t.modelSpec.length + ":" + (t.modelSpec === ${JSON.stringify(spec)}); })()`,
  );
  assert.equal(turnEntry.result, '503:true', 'the followUp-turn entry carries the whole spec verbatim');
  await ws.dispose();
});
