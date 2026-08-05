/**
 * Phase B tests: the guest library, the host bridge, and the console
 * bridge ($N freezing, settlement, reconciliation surface, snapshot
 * travel). Combinators are exercised over a mocked `__host_agent` that
 * settles synchronously (the eval's own drain completes the awaited
 * results) or on demand (started-not-awaited handles).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GUEST_LIBRARY_VERSION,
  GUEST_SURFACE_KEY,
  GUEST_VERSION_GLOBAL,
  HOST_AGENT,
  HOST_CHECKPOINT,
  HOST_CONSOLE,
  HOST_STEER,
  GuestLibraryInstallError,
  ReplVm,
  installGuestBridge,
  readGuestSurface,
  readRealmSlot,
  registerGuestHostCallbacks,
  type ConsoleEvent,
  type GuestBridgeHandlers,
  type GuestCall,
} from '../src/index.js';
import { buildGuestLibrarySource } from '../src/guest/guest-library.js';
import { getVmShim } from '../src/vm.js';
import type { QuickJS } from 'quickjs-wasi';

// ────────────────────────────────────────────────────────────────────────
// Mock host
// ────────────────────────────────────────────────────────────────────────

/** A scripted agent/steer resolution: resolve with `value` or reject with
 *  `error` (exactly one of the two). */
type Scripted = { resolveWith?: unknown; rejectWith?: unknown; assertPrompt?: string };

interface MockBridge {
  handlers: GuestBridgeHandlers;
  /** Every console event crossing the bridge, in order. */
  events: ConsoleEvent[];
  /** Agent calls, in issue order. */
  agentCalls: Array<{ call: GuestCall; callId: string; prompt: string; optionsJson: string | null }>;
  /** Steer calls, in issue order. */
  steerCalls: Array<{ call: GuestCall; callId: string; action: string; payloadJson: string | null }>;
  /** Checkpoint questions, keyed by call id (for answer delivery). */
  pendingCheckpoints: Map<string, GuestCall>;
  /** Scripted resolutions for agent/steer calls, consumed in order. */
  script: Scripted[];
}

function mockBridge(): MockBridge {
  const bridge: MockBridge = {
    handlers: {
      agent: (call, callId, prompt, optionsJson) => {
        bridge.agentCalls.push({ call, callId, prompt, optionsJson });
        settleScripted(bridge, call);
      },
      checkpoint: (call, callId, question, optionsJson, answerJson) => {
        if (answerJson !== null) {
          // Answer mode: settle the original pending checkpoint.
          const pending = bridge.pendingCheckpoints.get(callId);
          if (!pending) return false;
          bridge.pendingCheckpoints.delete(callId);
          pending.resolve(JSON.parse(answerJson));
          return true;
        }
        bridge.pendingCheckpoints.set(callId, call!);
        return undefined;
      },
      steer: (call, callId, action, payloadJson) => {
        bridge.steerCalls.push({ call, callId, action, payloadJson });
        settleScripted(bridge, call);
      },
      console: (event) => {
        bridge.events.push(event);
      },
    },
    events: [],
    agentCalls: [],
    steerCalls: [],
    pendingCheckpoints: new Map(),
    script: [],
  };
  return bridge;
}

function settleScripted(bridge: MockBridge, call: GuestCall): void {
  const s = bridge.script.shift();
  if (s === undefined) {
    // No script: park the call; the test settles it later.
    return;
  }
  if ('resolveWith' in s) call.resolve(s.resolveWith);
  else if ('rejectWith' in s) call.reject(s.rejectWith);
  // else: `{}` — parked (the test settles it later).
}

async function createGuest(): Promise<{ vm: ReplVm; bridge: MockBridge }> {
  const vm = await ReplVm.create();
  const bridge = mockBridge();
  await installGuestBridge(vm, bridge.handlers);
  return { vm, bridge };
}

function value(outcome: Awaited<ReturnType<ReplVm['evalCode']>>): unknown {
  assert.equal(outcome.kind, 'value', `expected value outcome, got ${JSON.stringify(outcome)}`);
  return outcome.value;
}

function pending(outcome: Awaited<ReturnType<ReplVm['evalCode']>>): void {
  assert.equal(outcome.kind, 'pending', `expected pending outcome, got ${JSON.stringify(outcome)}`);
}

// ────────────────────────────────────────────────────────────────────────
// Installation, version marker, deleted vocabulary
// ────────────────────────────────────────────────────────────────────────

test('install: the doc-mandated globals exist; phase() and the budget surface are deleted', async () => {
  const { vm } = await createGuest();
  const out = value(
    await vm.evalCode(`({
      agent: typeof agent, checkpoint: typeof checkpoint,
      answer: typeof checkpoint.answer,
      console: typeof console, log: typeof console.log,
      parallel: typeof parallel, pipeline: typeof pipeline, verify: typeof verify,
      judgePanel: typeof judgePanel, gate: typeof gate, retry: typeof retry,
      loopUntilDry: typeof loopUntilDry,
      phase: typeof phase, budget: typeof budget,
      hostBudget: typeof globalThis.__host_budget,
      marker: globalThis[Symbol.for(${JSON.stringify(GUEST_SURFACE_KEY)})] !== undefined,
      markerVersion: globalThis[Symbol.for(${JSON.stringify(GUEST_SURFACE_KEY)})].version,
    })`),
  );
  assert.deepEqual(out, {
    agent: 'function',
    checkpoint: 'function',
    answer: 'function',
    console: 'object',
    log: 'function',
    parallel: 'function',
    pipeline: 'function',
    verify: 'function',
    judgePanel: 'function',
    gate: 'function',
    retry: 'function',
    loopUntilDry: 'function',
    phase: 'undefined',
    budget: 'undefined',
    hostBudget: 'undefined',
    marker: true,
    markerVersion: GUEST_LIBRARY_VERSION,
  });
  // The version marker global is a non-writable, non-enumerable data property.
  const marker = value(await vm.evalCode(`(() => {
    const d = Object.getOwnPropertyDescriptor(globalThis, ${JSON.stringify(GUEST_VERSION_GLOBAL)});
    return { value: d.value, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable };
  })()`));
  assert.deepEqual(marker, {
    value: GUEST_LIBRARY_VERSION,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  vm.dispose();
});

test('install is idempotent: re-evaluating the library never wipes state or counters', async () => {
  const { vm } = await createGuest();
  value(await vm.evalCode('console.log("first"); "done"'));
  // The library guards itself: re-evaluation is a no-op.
  const outcome = await vm.evalCode(buildGuestLibrarySource());
  assert.equal(outcome.kind, 'value');
  value(await vm.evalCode('console.log("second"); "done"'));
  assert.equal(value(await vm.evalCode('typeof agent')), 'function');
  // The $N counter kept counting across the re-evaluation.
  const stats = readGuestSurface(vm)!;
  assert.equal(stats.stats().logSeq, 2);
  // installGuestBridge over an installed workspace is a no-op too.
  await installGuestBridge(vm, mockBridge().handlers);
  assert.equal(value(await vm.evalCode('1 + 1')), 2);
  vm.dispose();
});

test('a fresh VM without the bridge has no guest library (surface absent)', async () => {
  using vm = await ReplVm.create();
  assert.equal(readGuestSurface(vm), undefined);
  assert.deepEqual(readRealmSlot(vm, 'agent'), { kind: 'absent' });
  // The host functions are not installed either.
  assert.deepEqual(readRealmSlot(vm, HOST_AGENT), { kind: 'absent' });
});

// ────────────────────────────────────────────────────────────────────────
// agent() and the live handle
// ────────────────────────────────────────────────────────────────────────

test('agent() round trip: the mocked host receives the call and its result resolves in-eval', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({ resolveWith: 'research done' });
  assert.equal(value(await vm.evalCode('await agent("research X")')), 'research done');
  assert.equal(bridge.agentCalls.length, 1);
  assert.equal(bridge.agentCalls[0].callId, 'c1');
  assert.equal(bridge.agentCalls[0].prompt, 'research X');
  assert.equal(bridge.agentCalls[0].optionsJson, null);
  vm.dispose();
});

test('agent() options cross the bridge as JSON (schema, cwd, backend config)', async () => {
  const { vm, bridge } = await createGuest();
  const options = { schema: { type: 'object', required: ['x'] }, cwd: '/tmp', backend: { model: 'm' } };
  bridge.script.push({ resolveWith: { x: 1 } });
  const result = value(await vm.evalCode(`await agent("p", ${JSON.stringify(options)})`));
  assert.deepEqual(result, { x: 1 });
  const parsed = JSON.parse(bridge.agentCalls[0].optionsJson!);
  assert.deepEqual(parsed, options);
  vm.dispose();
});

test('agent() validation: a non-string prompt rejects with a TypeError', async () => {
  const { vm } = await createGuest();
  const e = await vm.evalCode('await agent(42).then(() => "no", (err) => err.message)');
  assert.equal(value(e), 'agent(prompt, options?) needs a prompt string');
  vm.dispose();
});

test('agent() rejections normalize to Errors carrying code/recoverable', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({ rejectWith: { message: 'cap hit', code: 'X', recoverable: false } });
  const e = await vm.evalCode('await agent("p").then(() => "no", (err) => ({ name: err.name, message: err.message, code: err.code, recoverable: err.recoverable }))');
  assert.deepEqual(value(e), { name: 'Error', message: 'cap hit', code: 'X', recoverable: false });
  vm.dispose();
});

test('a host handler that throws synchronously rejects the call (documented refusal path)', async () => {
  const { vm } = await createGuest();
  const bridge = mockBridge();
  // Replace the agent handler with a throwing one — the shim turns the
  // throw into a guest error, which issueCall converts into a rejection.
  // Re-installing callbacks over the live workspace keeps the library.
  bridge.handlers.agent = () => {
    throw new Error('refused at dispatch');
  };
  await installGuestBridge(vm, bridge.handlers); // no-op (already installed) — so register directly
  registerGuestHostCallbacks(vm, bridge.handlers);
  const e = await vm.evalCode('await agent("p").then(() => "no", (err) => err.message)');
  assert.equal(value(e), 'refused at dispatch');
  vm.dispose();
});

test('the handle: agent() returns a promise carrying id, followUp, steer, cancel (non-enumerable)', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({ resolveWith: 'result' });
  bridge.script.push({ resolveWith: 'injected' });
  bridge.script.push({ resolveWith: 'startedNewTurn' });
  bridge.script.push({ resolveWith: 'cancelled' });
  const out = value(
    await vm.evalCode(`
      const h = agent("p");
      const before = h instanceof Promise;
      const desc = Object.getOwnPropertyDescriptors(h);
      const [f, s, c] = [await h.followUp("more", { label: "x" }), await h.steer("urgent"), await h.cancel()];
      const result = await h;
      ({ before, result, f, s, c,
        id: h.id, hasId: "id" in desc, enumerable: desc.id ? desc.id.enumerable : null,
        keys: Object.keys(h) })
    `),
  );
  assert.deepEqual(out, {
    before: true,
    result: 'result',
    f: 'injected',
    s: 'startedNewTurn',
    c: 'cancelled',
    id: 'c1',
    hasId: true,
    enumerable: false,
    keys: [],
  });
  // The steer calls carried the right action + payload (cancel payload null).
  assert.equal(bridge.steerCalls.length, 3);
  assert.deepEqual(bridge.steerCalls.map((c) => c.action), ['followUp', 'steer', 'cancel']);
  assert.deepEqual(JSON.parse(bridge.steerCalls[0].payloadJson!), { prompt: 'more', options: { label: 'x' } });
  assert.equal(bridge.steerCalls[2].payloadJson, null);
  // Steering addresses the founding call id.
  assert.ok(bridge.steerCalls.length === 3, `expected 3 steer calls, got ${bridge.steerCalls.length}`);
  for (const c of bridge.steerCalls) {
    assert.equal(c.callId, 'c1', `steer call ${c.action} addressed ${c.callId}`);
  }
  vm.dispose();
});

test('handle validation: followUp/steer need a prompt string; cancel takes none', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({ resolveWith: 'x' });
  const out = value(
    await vm.evalCode(`
      const h = agent("p");
      const bad = await h.followUp(42).then(() => "no", (err) => err.name);
      const badCancel = await (async () => { try { h.cancel("nope"); return "no-throw"; } catch (e) { return e.name; } })();
      ({ bad, badCancel })
    `),
  );
  assert.deepEqual(out, { bad: 'TypeError', badCancel: 'no-throw' });
  vm.dispose();
});

test('started-not-awaited handles: settlement arrives through a later standalone drain', async () => {
  const { vm, bridge } = await createGuest();
  // No scripted resolution: the call parks in the mock.
  const first = await vm.evalCode('const research = agent("research Y"); "started"');
  assert.equal(value(first), 'started');
  assert.equal(bridge.agentCalls.length, 1);
  // Nothing has settled yet: awaiting the still-pending handle suspends the eval.
  const still = await vm.evalCode('await research');
  pending(still);
  // The host settles the call, then the drain fires the continuation.
  bridge.agentCalls[0].call.resolve({ findings: [1, 2] });
  vm.drainJobs();
  assert.deepEqual(value(await vm.evalCode('await research')), { findings: [1, 2] });
  vm.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// checkpoint() / checkpoint.answer()
// ────────────────────────────────────────────────────────────────────────

test('checkpoint question → answer flow across evals', async () => {
  const { vm } = await createGuest();
  // Ask a question (the eval suspends on it).
  const asked = await vm.evalCode('const q = checkpoint("proceed?"); "asked"');
  assert.equal(value(asked), 'asked');
  assert.equal(vm.drainJobs(), 0);
  // The orchestrator delivers the answer in a later eval.
  const answered = value(
    await vm.evalCode('checkpoint.answer("c1", { yes: true, note: "go" }); "delivered"'),
  );
  assert.equal(answered, 'delivered');
  // The checkpoint promise resolved with the answer during that eval's drain.
  assert.deepEqual(value(await vm.evalCode('await q')), { yes: true, note: 'go' });
  vm.dispose();
});

test('checkpoint.answer returns false for unknown or already-answered ids', async () => {
  const { vm } = await createGuest();
  value(await vm.evalCode('const q = checkpoint("q"); "asked"'));
  assert.equal(value(await vm.evalCode('checkpoint.answer("c99", 1)')), false);
  assert.equal(value(await vm.evalCode('checkpoint.answer("c1", 1); checkpoint.answer("c1", 2)')), false);
  vm.dispose();
});

test('checkpoint.answer with a non-JSON value throws a TypeError (synchronously)', async () => {
  const { vm } = await createGuest();
  value(await vm.evalCode('const q = checkpoint("q"); "asked"'));
  const e = value(await vm.evalCode(`
    (() => { try { checkpoint.answer("c1", (() => { const o = {}; o.self = o; return o; })()); return "no-throw"; } catch (err) { return err.name; } })()
  `));
  assert.equal(e, 'TypeError');
  vm.dispose();
});

test('checkpoint options cross the bridge as JSON', async () => {
  const { vm, bridge } = await createGuest();
  value(await vm.evalCode('checkpoint("q", { choices: ["a", "b"] }); "asked"'));
  const surface = readGuestSurface(vm)!;
  const pendingList = surface.pending();
  assert.equal(pendingList.length, 1);
  assert.equal(pendingList[0].kind, 'checkpoint');
  assert.equal(pendingList[0].detail, 'q');
  assert.equal(pendingList[0].optionsJson, '{"choices":["a","b"]}');
  vm.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// Combinators over a mocked agent()
// ────────────────────────────────────────────────────────────────────────

test('parallel: runs thunks concurrently, resolves in input order, recoverable failures become null slots', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({ resolveWith: 'a' });
  bridge.script.push({ rejectWith: { message: 'boom' } }); // recoverable (no flag)
  bridge.script.push({ resolveWith: 'c' });
  const out = value(await vm.evalCode('await parallel([() => agent("a"), () => agent("b"), () => agent("c")])'));
  assert.deepEqual(out, ['a', null, 'c']);
  // The swallowed failure was reported through console.warn (the bridge).
  assert.ok(bridge.events.some((e) => e.level === 'warn' && e.args.some((a) => typeof a === 'string' && a.includes('parallel[1] failed: boom'))));
  vm.dispose();
});

test('parallel: non-recoverable failures (recoverable: false) halt the whole parallel', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({ rejectWith: { message: 'halt', recoverable: false } });
  const e = await vm.evalCode('await parallel([() => agent("a"), () => agent("b")]).then(() => "no", (err) => err.message)');
  assert.equal(value(e), 'halt');
  vm.dispose();
});

test('parallel: validates its input (functions, not promises)', async () => {
  const { vm } = await createGuest();
  assert.equal(
    value(await vm.evalCode('await parallel([agent("a")]).then(() => "no", (err) => err.name)')),
    'TypeError',
  );
  assert.equal(value(await vm.evalCode('await parallel("nope").then(() => "no", (err) => err.name)')), 'TypeError');
  vm.dispose();
});

test('pipeline: stages run sequentially per item, concurrently across items', async () => {
  const { vm } = await createGuest();
  const out = value(
    await vm.evalCode(`
      await pipeline(
        [1, 2, 3],
        (prev, original, index) => prev * 10 + original + index,
        async (prev) => prev + 1,
      )
    `),
  );
  // item 1: (1*10+1+0)+1 = 12; item 2: (2*10+2+1)+1 = 24; item 3: (3*10+3+2)+1 = 36
  assert.deepEqual(out, [12, 24, 36]);
  vm.dispose();
});

test('pipeline: recoverable per-item failures yield null; non-recoverable halt', async () => {
  const { vm } = await createGuest();
  const out = value(
    await vm.evalCode(`
      await pipeline(
        [1, 2, 3],
        (prev) => { if (prev === 2) throw { message: 'skip me' }; return prev; },
      )
    `),
  );
  assert.deepEqual(out, [1, null, 3]);
  const e = await vm.evalCode(`
    await pipeline([1], () => { throw { message: 'halt', recoverable: false }; }).then(() => "no", (err) => err.message)
  `);
  assert.equal(value(e), 'halt');
  vm.dispose();
});

test('retry: bounded attempts, early stop on until()', async () => {
  const { vm } = await createGuest();
  const out = value(
    await vm.evalCode(`
      let tries = 0;
      const last = await retry(
        () => { tries++; return tries < 5 ? 'not yet' : 'ok'; },
        { attempts: 3 },
      );
      ({ last, tries })
    `),
  );
  assert.deepEqual(out, { last: 'not yet', tries: 3 });
  const out2 = value(
    await vm.evalCode(`
      let tries2 = 0;
      const last2 = await retry(
        () => { tries2++; return tries2 === 2 ? 'good' : 'bad'; },
        { attempts: 5, until: (r) => r === 'good' },
      );
      ({ last: last2, tries: tries2 })
    `),
  );
  assert.deepEqual(out2, { last: 'good', tries: 2 });
  vm.dispose();
});

test('gate: validator feedback loops into the next attempt; verdict shapes are honored', async () => {
  const { vm } = await createGuest();
  const out = value(
    await vm.evalCode(`
      const history = [];
      const result = await gate(
        (feedback, attempt) => { history.push({ feedback, attempt }); return 'draft ' + attempt; },
        (value) => value === 'draft 2' ? { ok: true, feedback: 'pass' } : { ok: false, feedback: 'needs work' },
        { attempts: 4 },
      );
      ({ result, history })
    `),
  );
  assert.deepEqual(out, {
    result: { ok: true, value: 'draft 2', verdict: { ok: true, feedback: 'pass' }, attempts: 3 },
    history: [
      { feedback: undefined, attempt: 0 },
      { feedback: 'needs work', attempt: 1 },
      { feedback: 'needs work', attempt: 2 },
    ],
  });
  // Boolean verdicts work too; exhausted attempts report ok: false.
  const out2 = value(
    await vm.evalCode(`
      const result2 = await gate(
        () => 'x',
        () => false,
        { attempts: 2 },
      );
      result2
    `),
  );
  assert.deepEqual(out2, { ok: false, value: 'x', verdict: false, attempts: 2 });
  vm.dispose();
});

test('loopUntilDry: dedupes by key, stops after consecutiveEmpty empty rounds, honors maxRounds', async () => {
  const { vm } = await createGuest();
  const out = value(
    await vm.evalCode(`
      let round = 0;
      const items = await loopUntilDry({
        round: () => {
          round++;
          if (round === 1) return [{ id: 1 }, { id: 1 }, { id: 2 }];
          if (round === 2) return [{ id: 3 }];
          return [];
        },
        key: (x) => 'k' + x.id,
        consecutiveEmpty: 2,
        maxRounds: 10,
      });
      ({ items, round })
    `),
  );
  assert.deepEqual(out, { items: [{ id: 1 }, { id: 2 }, { id: 3 }], round: 4 });
  // maxRounds caps the loop even when never dry.
  const out2 = value(
    await vm.evalCode(`
      let n2 = 0;
      const items2 = await loopUntilDry({
        round: () => { n2++; return [{ n: n2 }]; },
        key: (x) => 'n' + x.n,
        maxRounds: 3,
      });
      ({ count: items2.length, n: n2 })
    `),
  );
  assert.deepEqual(out2, { count: 3, n: 3 });
  vm.dispose();
});

test('loopUntilDry: the default key degrades safely for circular items', async () => {
  const { vm } = await createGuest();
  const out = value(
    await vm.evalCode(`
      const circle = { name: 'c' }; circle.self = circle;
      const items = await loopUntilDry({
        round: async (r) => r === 0 ? [circle] : [],
        consecutiveEmpty: 1,
      });
      items.length
    `),
  );
  assert.equal(out, 1);
  vm.dispose();
});

test('verify: reviewers vote; passes when the real-share meets threshold', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({ resolveWith: { real: true, reason: 'yes' } });
  bridge.script.push({ resolveWith: { real: false, reason: 'no' } });
  bridge.script.push({ resolveWith: { real: true, reason: 'yes2' } });
  const out = value(await vm.evalCode('await verify("claim", { reviewers: 3, threshold: 0.5 })'));
  assert.deepEqual(out, {
    real: true,
    realCount: 2,
    total: 3,
    votes: [
      { real: true, reason: 'yes' },
      { real: false, reason: 'no' },
      { real: true, reason: 'yes2' },
    ],
  });
  // Reviewers were spawned as schema-carrying agent calls.
  assert.equal(bridge.agentCalls.length, 3);
  for (const call of bridge.agentCalls) {
    const options = JSON.parse(call.optionsJson!);
    assert.equal(options.schema.type, 'object');
    assert.ok(call.prompt.includes('claim'));
  }
  vm.dispose();
});

test('verify: recoverably-failed reviewers are dropped from the vote', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({ resolveWith: { real: true } });
  bridge.script.push({ rejectWith: { message: 'worker died' } });
  bridge.script.push({ resolveWith: { real: true } });
  const out = value(await vm.evalCode('await verify("claim", { reviewers: 3 })'));
  assert.equal(out.real, true);
  assert.equal(out.total, 2);
  vm.dispose();
});

test('judgePanel: highest mean score wins; stable tie-break by index', async () => {
  const { vm, bridge } = await createGuest();
  // Candidate 1 scores 0.4/0.6 → 0.5; candidate 2 scores 0.8/0.6 → 0.7;
  // candidate 3 ties candidate 1 at 0.5 → index 2 loses the tie to 0.
  bridge.script.push(
    { resolveWith: { score: 0.4, reason: 'r' } },
    { resolveWith: { score: 0.6, reason: 'r' } },
    { resolveWith: { score: 0.8, reason: 'r' } },
    { resolveWith: { score: 0.6, reason: 'r' } },
    { resolveWith: { score: 0.5, reason: 'r' } },
    { resolveWith: { score: 0.5, reason: 'r' } },
  );
  const out = value(
    await vm.evalCode('await judgePanel(["cand-a", "cand-b", "cand-c"], { judges: 2, rubric: "quality" })'),
  );
  assert.equal(out.index, 1);
  assert.equal(out.attempt, 'cand-b');
  assert.ok(Math.abs(out.score - 0.7) < 1e-9);
  assert.equal(out.judgments.length, 2);
  // Judge prompts carried the rubric.
  assert.ok(bridge.agentCalls.some((c) => c.prompt.includes('quality')));
  vm.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// The console bridge and $N freezing
// ────────────────────────────────────────────────────────────────────────

test('console.log freezes arguments into $N: mutation after the log does not change the store', async () => {
  const { vm } = await createGuest();
  value(
    await vm.evalCode(`
      const x = { a: 1, nested: { b: [1, 2, 3] } };
      console.log(x);
      x.a = 999;
      x.nested.b.push(4);
      const y = [1, 2];
      console.log(y);
      y[0] = 'changed';
      'done'
    `),
  );
  assert.deepEqual(value(await vm.evalCode('$1')), { a: 1, nested: { b: [1, 2, 3] } });
  assert.deepEqual(value(await vm.evalCode('$2')), [1, 2]);
  vm.dispose();
});

test('the $N store is the agent workspace: slots are writable, deletable, transformable', async () => {
  const { vm } = await createGuest();
  value(await vm.evalCode('console.log({ v: 1 }); "done"'));
  assert.equal(value(await vm.evalCode('$1.v = 2; $1.v')), 2);
  assert.equal(value(await vm.evalCode('delete globalThis.$1; typeof $1')), 'undefined');
  vm.dispose();
});

test('the console payload carries refs and best-effort args; every level routes through the bridge', async () => {
  const { vm, bridge } = await createGuest();
  value(
    await vm.evalCode(`
      console.log("plain", 42);
      console.warn("careful");
      console.error("boom");
      console.info("note");
      console.debug("detail");
      "done"
    `),
  );
  assert.equal(bridge.events.length, 5);
  assert.deepEqual(bridge.events.map((e) => e.level), ['log', 'warn', 'error', 'info', 'debug']);
  assert.deepEqual(bridge.events[0].refs, ['$1', '$2']);
  assert.deepEqual(bridge.events[0].args, ['plain', 42]);
  // Long strings are capped in args (the full value lives in $N).
  value(await vm.evalCode(`console.log(${JSON.stringify('x'.repeat(5000))}); "done"`));
  const last = bridge.events[5];
  assert.equal(typeof last.args[0], 'string');
  assert.ok(last.args[0].length < 5000);
  assert.match(last.args[0] as string, /full value in \$N/);
  vm.dispose();
});

test('console.* never throws: hostile values degrade to typed markers in their own slots', async () => {
  const { vm, bridge } = await createGuest();
  value(
    await vm.evalCode(`
      console.log(Symbol('s'), function named() {}, new Promise(() => {}), new WeakMap(), new WeakSet());
      "done"
    `),
  );
  assert.equal(bridge.events.length, 1);
  assert.equal(bridge.events[0].refs.length, 5);
  // Symbols/functions/promises became __unclonable__ markers in $N.
  const kinds = value(
    await vm.evalCode(`[1, 2, 3, 4, 5].map((n) => globalThis['$' + n].__unclonable__)`),
  );
  assert.deepEqual(kinds, ['symbol', 'function', 'promise', 'weakmap', 'weakset']);
  // A revoked proxy degrades to a marker too — and console never throws.
  const out = value(
    await vm.evalCode(`
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      let threw = false;
      try { console.log(proxy, { ok: 1 }); } catch (e) { threw = true; }
      ({ threw, second: globalThis.$7 })
    `),
  );
  assert.equal(out.threw, false);
  assert.deepEqual(out.second, { ok: 1 });
  vm.dispose();
});

test('deeply nested logged values do not crash the VM (iterative fallback, no depth bound)', async () => {
  const { vm } = await createGuest();
  value(
    await vm.evalCode(`
      let root = {}; let cur = root;
      for (let i = 0; i < 2000; i++) { cur.next = {}; cur = cur.next; }
      cur.leaf = 'bottom';
      console.log(root);
      "done"
    `),
  );
  // The full 2000-deep structure was frozen into $1 (iterative copy).
  const depth = value(
    await vm.evalCode(`
      let d = 0; let walk = $1;
      while (walk && typeof walk === 'object' && 'next' in walk) { walk = walk.next; d++; }
      ({ d, leaf: walk ? walk.leaf : null })
    `),
  );
  assert.equal(depth.d, 2000);
  assert.equal(depth.leaf, 'bottom');
  // The VM is fully usable.
  assert.equal(value(await vm.evalCode('1 + 1')), 2);
  vm.dispose();
});

test('console.log of a cyclic value freezes a cycle-preserving copy into $N', async () => {
  const { vm } = await createGuest();
  value(
    await vm.evalCode(`
      const o = { name: 'ring' }; o.self = o;
      console.log(o);
      "done"
    `),
  );
  assert.equal(value(await vm.evalCode('$1.self.self.name')), 'ring');
  vm.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// The reconciliation surface
// ────────────────────────────────────────────────────────────────────────

test('surface.pending() lists parked calls oldest-first with verbatim details', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({}); // park
  value(await vm.evalCode('agent("first"); "ok"'));
  value(await vm.evalCode('agent("second", { label: "l" }); "ok"'));
  value(await vm.evalCode('checkpoint("question?"); "ok"'));
  const surface = readGuestSurface(vm)!;
  assert.equal(surface.version, GUEST_LIBRARY_VERSION);
  const pendingList = surface.pending();
  assert.deepEqual(
    pendingList.map((e) => ({ id: e.id, kind: e.kind, detail: e.detail, optionsJson: e.optionsJson })),
    [
      { id: 'c1', kind: 'agent', detail: 'first', optionsJson: null },
      { id: 'c2', kind: 'agent', detail: 'second', optionsJson: '{"label":"l"}' },
      { id: 'c3', kind: 'checkpoint', detail: 'question?', optionsJson: null },
    ],
  );
  vm.dispose();
});

test('surface.settle() settles parked calls (the reconciliation route); first settlement wins', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({}); // park c1
  value(await vm.evalCode('const p = agent("work"); "ok"'));
  const surface = readGuestSurface(vm)!;
  assert.equal(surface.settle('c1', 'resolve', { done: true }), true);
  vm.drainJobs();
  assert.deepEqual(value(await vm.evalCode('await p')), { done: true });
  // Second settlement of the same id is a no-op; unknown ids are false.
  assert.equal(surface.settle('c1', 'resolve', 'again'), false);
  assert.equal(surface.settle('c99', 'resolve', 'x'), false);
  // Rejections through the surface normalize into Errors guest-side.
  bridge.script.push({});
  value(await vm.evalCode('const q = agent("w2"); "ok"'));
  assert.equal(surface.settle('c2', 'reject', { message: 'gone', recoverable: true }), true);
  vm.drainJobs();
  const msg = value(await vm.evalCode('await q.then(() => "no", (err) => err.message)'));
  assert.equal(msg, 'gone');
  vm.dispose();
});

test('surface.stats() reports the counters; settlement empties the registry', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({});
  bridge.script.push({});
  value(await vm.evalCode('agent("a"); agent("b"); "ok"'));
  const surface = readGuestSurface(vm)!;
  assert.deepEqual(surface.stats(), {
    version: GUEST_LIBRARY_VERSION,
    callSeq: 2,
    logSeq: 0,
    pendingCalls: 2,
  });
  surface.settle('c1', 'resolve', 1);
  assert.equal(surface.stats().pendingCalls, 1);
  vm.dispose();
});

test('the surface survives Map.prototype pollution (captured intrinsics)', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({});
  value(await vm.evalCode('agent("a"); "ok"'));
  value(
    await vm.evalCode(`
      let traps = 0;
      Map.prototype.set = function () { traps++; };
      Map.prototype.forEach = function () { traps++; };
      Object.defineProperty(Map.prototype, 'size', { get() { traps++; return 0; } });
      "polluted"
    `),
  );
  const surface = readGuestSurface(vm)!;
  const pendingList = surface.pending();
  assert.equal(pendingList.length, 1);
  assert.equal(pendingList[0].id, 'c1');
  assert.equal(surface.stats().pendingCalls, 1);
  assert.equal(surface.settle('c1', 'resolve', 'ok'), true);
  assert.equal(value(await vm.evalCode('traps')), 0, 'no polluted Map method ran');
  vm.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// Snapshot travel (the evolution discipline: the library travels inside
// snapshots; the host re-registers callbacks by name after restore)
// ────────────────────────────────────────────────────────────────────────

test('snapshot/restore: state, $N store, pending registry and version marker travel; callbacks re-register by name', async () => {
  const { vm, bridge } = await createGuest();
  // Park one agent call and one checkpoint; log something; hold state.
  bridge.script.push({}); // park c1
  value(await vm.evalCode('const findings = [1, 2, 3]; const research = agent("deep dive"); "ok"'));
  value(await vm.evalCode('const q = checkpoint("still there?"); console.log(findings); "ok"'));
  const snapshot = (getVmShim(vm) as QuickJS).snapshot();
  const surfaceBefore = readGuestSurface(vm)!;
  assert.equal(surfaceBefore.pending().length, 2);
  vm.dispose();

  // Restore into a fresh instance; re-register the host callbacks by name.
  const restored = await ReplVm.restore(snapshot);
  const restoredBridge = mockBridge();
  // The restored workspace's parked calls are settled through the
  // reconciliation surface (the live deferreds died with the old instance).
  registerGuestHostCallbacks(restored, restoredBridge.handlers);
  const surface = readGuestSurface(restored)!;
  assert.equal(surface.version, GUEST_LIBRARY_VERSION, 'resident version survives');
  const pendingList = surface.pending();
  assert.deepEqual(pendingList.map((e) => e.kind), ['agent', 'checkpoint']);
  assert.equal(pendingList[0].detail, 'deep dive');
  // State and the $N store survived.
  assert.deepEqual(value(await restored.evalCode('findings')), [1, 2, 3]);
  assert.deepEqual(value(await restored.evalCode('$1')), [1, 2, 3]);
  // Settle the parked calls (three-way reconciliation: completed while
  // down → settle from the store; here the mock settles both).
  assert.equal(surface.settle('c1', 'resolve', { report: 'done' }), true);
  assert.equal(surface.settle('c2', 'resolve', 'yes still here'), true);
  restored.drainJobs();
  assert.deepEqual(value(await restored.evalCode('await research')), { report: 'done' });
  assert.equal(value(await restored.evalCode('await q')), 'yes still here');
  // The library is NOT re-evaluated on restore (idempotence guard); the
  // guest globals still work and new calls mint fresh ids.
  assert.equal(value(await restored.evalCode('typeof agent')), 'function');
  restoredBridge.script.push({ resolveWith: 'after' });
  assert.equal(value(await restored.evalCode('await agent("next")')), 'after');
  restored.dispose();
});

test('a VM restored from a snapshot keeps working without the guest library re-injected', async () => {
  // Covered by the travel test above; this pins the no-op guard once more
  // on the restored workspace: installGuestBridge must not re-evaluate.
  const { vm } = await createGuest();
  value(await vm.evalCode('globalThis.counter = 7; "ok"'));
  const snapshot = (getVmShim(vm) as QuickJS).snapshot();
  vm.dispose();
  const restored = await ReplVm.restore(snapshot);
  const bridge = mockBridge();
  await installGuestBridge(restored, bridge.handlers); // no-op
  assert.equal(value(await restored.evalCode('counter + 1')), 8);
  restored.dispose();
});

test('GuestLibraryInstallError carries trap-free info (the install-failure surface)', async () => {
  // The shipped library source is static and covered by every install in
  // this suite; the error class is the surface an install failure would
  // surface through. Constructible with EvalErrorInfo, exactly like the
  // eval-failure report.
  const err = new GuestLibraryInstallError({
    name: 'SyntaxError',
    message: 'boom',
    interrupted: false,
    outOfMemory: false,
  });
  assert.equal(err.name, 'GuestLibraryInstallError');
  assert.match(err.message, /SyntaxError: boom/);
  assert.equal(err.info.outOfMemory, false);
});

test('surface.settle validates its outcome argument (host-side pre-validation avoids the throw path)', async () => {
  const { vm } = await createGuest();
  const surface = readGuestSurface(vm)!;
  // Host-side validation happens before the guest call: an invalid outcome
  // is a TypeError from the facade (the guest's own TypeError is the same).
  assert.throws(() => surface.settle('c1', 'bogus' as 'resolve', 1), TypeError);
  vm.dispose();
});
