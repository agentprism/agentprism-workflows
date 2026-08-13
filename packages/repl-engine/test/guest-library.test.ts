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
  type ConsoleLevel,
  type GuestBridgeHandlers,
  type GuestCall,
} from '../src/index.js';
import { buildGuestLibrarySource } from '../src/guest/guest-library.js';
import { getVmShim } from '../src/vm.js';
import type { JSValueHandle, QuickJS, HostFunction } from 'quickjs-wasi';

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
  agentCalls: Array<{ call: GuestCall; callId: string; modelSpec: string; task: string; optionsJson: string | null }>;
  /** Steer calls, in issue order. */
  steerCalls: Array<{ call: GuestCall; callId: string; sessionId: string; action: string; payloadJson: string | null }>;
  /** Checkpoint questions, keyed by call id (for answer delivery). */
  pendingCheckpoints: Map<string, GuestCall>;
  /** Scripted resolutions for agent/steer calls, consumed in order. */
  script: Scripted[];
}

function mockBridge(): MockBridge {
  const bridge: MockBridge = {
    handlers: {
      agent: (call, callId, modelSpec, task, optionsJson) => {
        bridge.agentCalls.push({ call, callId, modelSpec, task, optionsJson });
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
      steer: (call, callId, sessionId, action, payloadJson) => {
        bridge.steerCalls.push({ call, callId, sessionId, action, payloadJson });
        settleScripted(bridge, call);
      },
      console: (event) => {
        bridge.events.push(event);
      },
      sleep: (call, ms) => {
        setTimeout(() => {
          try {
            call.resolve(undefined);
          } catch {
            // vm disposed mid-sleep — nothing to settle.
          }
        }, ms);
      },
      workspace: () => '{}',
      agents: () => '[]',
      reset: () => undefined,
      defaultBackend: () => 'claude',
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

/**
 * Install the guest library at an arbitrary version, with minimal
 * host functions — simulates the OLDER host that snapshotted a workspace
 * (the doc's evolution discipline: a host must serve snapshots carrying
 * older library versions than the one it currently injects, and the
 * resident version stays authoritative). The minimal surface is enough
 * for the discipline assertions: agent/steer/checkpoint park (their
 * registry entries pend), answer mode reports false, console events
 * bridge into the mock's event list.
 */
async function installGuestLibraryAtVersion(
  vm: ReplVm,
  version: string,
  bridge: MockBridge,
): Promise<void> {
  const shim = getVmShim(vm) as QuickJS;
  const hostFn = (
    fn: (args: Array<string | null>) => JSValueHandle | undefined,
  ): HostFunction => {
    return function (this: JSValueHandle, ...args: JSValueHandle[]): JSValueHandle {
      const strs = args.map((a) => (a.isString ? a.toString() : null));
      return fn(strs) ?? shim.undefined;
    };
  };
  const callbacks: Array<[string, (args: Array<string | null>) => JSValueHandle | undefined]> = [
    [HOST_AGENT, () => undefined],
    [HOST_CHECKPOINT, (args) => (args.length >= 4 ? shim.false : undefined)],
    [HOST_STEER, () => undefined],
    [
      HOST_CONSOLE,
      (args) => {
        const level = args[0];
        const payload = args[1] !== null ? JSON.parse(args[1]) : null;
        if (level !== null && payload !== null && typeof payload.line === 'string') {
          bridge.events.push({ level: level as ConsoleLevel, line: payload.line as string });
        }
        return undefined;
      },
    ],
  ];
  for (const [name, fn] of callbacks) {
    const fnHandle = shim.newFunction(name, hostFn(fn));
    shim.setProp(shim.global, name, fnHandle);
    fnHandle.dispose();
  }
  const outcome = await vm.evalCode(buildGuestLibrarySource(version));
  assert.equal(outcome.kind, 'value', `library v${version} install failed: ${JSON.stringify(outcome)}`);
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
      sleep: typeof sleep, workspace: typeof workspace, agents: typeof agents,
      reset: typeof reset, underscore: typeof _,
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
    sleep: 'function',
    workspace: 'function',
    agents: 'function',
    reset: 'function',
    underscore: 'undefined',
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
  value(await vm.evalCode('agent("pi/x", "first"); "done"'));
  // The library guards itself: re-evaluation is a no-op.
  const outcome = await vm.evalCode(buildGuestLibrarySource());
  assert.equal(outcome.kind, 'value');
  value(await vm.evalCode('agent("pi/x", "second"); "done"'));
  assert.equal(value(await vm.evalCode('typeof agent')), 'function');
  // The call-id counter kept counting across the re-evaluation.
  const stats = readGuestSurface(vm)!;
  assert.equal(stats.stats().callSeq, 2);
  assert.equal(stats.stats().pendingCalls, 2);
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

test('agent() round trip: the mocked host receives modelSpec + task and its result resolves in-eval', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({ resolveWith: 'research done' });
  assert.equal(value(await vm.evalCode('await agent("pi/deepseek-v4-flash-max", "research X")')), 'research done');
  assert.equal(bridge.agentCalls.length, 1);
  assert.equal(bridge.agentCalls[0].callId, 'c1');
  assert.equal(bridge.agentCalls[0].modelSpec, 'pi/deepseek-v4-flash-max');
  assert.equal(bridge.agentCalls[0].task, 'research X');
  assert.equal(bridge.agentCalls[0].optionsJson, null);
  vm.dispose();
});

test('agent() options cross the bridge as JSON (schema, cwd, configOptions, mode)', async () => {
  const { vm, bridge } = await createGuest();
  const options = {
    schema: { type: 'object', required: ['x'] },
    cwd: '/tmp',
    configOptions: { thinkingLevel: 'high' },
    mode: 'read-only',
  };
  bridge.script.push({ resolveWith: { x: 1 } });
  const result = value(await vm.evalCode(`await agent("pi/default", "p", ${JSON.stringify(options)})`));
  assert.deepEqual(result, { x: 1 });
  const parsed = JSON.parse(bridge.agentCalls[0].optionsJson!);
  assert.deepEqual(parsed, options);
  vm.dispose();
});

test('agent() preserves unknown option keys with non-JSON-representable values for host validation', async () => {
  const { vm, bridge } = await createGuest();
  const rejection = {
    rejectWith: {
      message: 'agent options: unknown option "bogus" (valid options: schema, cwd, configOptions, mode)',
      code: 'SCRIPT_VALIDATION_ERROR',
      recoverable: false,
      replBackend: 'pi',
    },
  };
  bridge.script.push(rejection, rejection, rejection, rejection);
  const values = ['undefined', 'function () {}', 'Symbol("s")', '10n'];
  for (const optionValue of values) {
    const message = value(
      await vm.evalCode(
        `await agent("pi/x", "task", { bogus: ${optionValue} }).then(() => "accepted", (err) => err.code + "|" + err.message)`,
      ),
    );
    assert.equal(
      message,
      'SCRIPT_VALIDATION_ERROR|agent options: unknown option "bogus" (valid options: schema, cwd, configOptions, mode)',
    );
  }
  assert.equal(bridge.agentCalls.length, 4);
  assert.deepEqual(
    bridge.agentCalls.map((call) => call.optionsJson),
    ['{"bogus":null}', '{"bogus":null}', '{"bogus":null}', '{"bogus":null}'],
    'every present unknown key survives the JSON bridge regardless of its value',
  );
  assert.equal(readGuestSurface(vm)!.stats().pendingCalls, 0, 'the synchronous host refusal settled the registry');
  vm.dispose();
});

test('agent() omits undefined known options while still dispatching the call', async () => {
  const { vm, bridge } = await createGuest();
  const options = [
    '{ schema: undefined }',
    '{ cwd: undefined }',
    '{ configOptions: undefined }',
    '{ mode: undefined }',
    '{ cwd: "/tmp", schema: undefined }',
    '{ configOptions: { thinkingLevel: undefined } }',
  ];
  bridge.script.push(...options.map(() => ({ resolveWith: 'accepted' })));
  for (const option of options) {
    assert.equal(
      value(await vm.evalCode(`await agent("pi/x", "task", ${option})`)),
      'accepted',
      `${option} dispatches`,
    );
  }
  assert.deepEqual(
    bridge.agentCalls.map((call) => call.optionsJson),
    ['{}', '{}', '{}', '{}', '{"cwd":"/tmp"}', '{"configOptions":{}}'],
    'known undefined values retain ordinary JSON omission semantics at every depth',
  );
  vm.dispose();
});

test('agent() validation: non-string modelSpec/task reject with a TypeError', async () => {
  const { vm } = await createGuest();
  const e1 = await vm.evalCode('await agent(42, "task").then(() => "no", (err) => err.message)');
  assert.match(value(e1), /model spec string/);
  const e2 = await vm.evalCode('await agent("pi/x", 42).then(() => "no", (err) => err.message)');
  assert.match(value(e2), /task string/);
  vm.dispose();
});

test('agent() rejections normalize to Errors carrying code/recoverable', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({ rejectWith: { message: 'cap hit', code: 'X', recoverable: false } });
  const e = await vm.evalCode('await agent("pi/x", "p").then(() => "no", (err) => ({ name: err.name, message: err.message, code: err.code, recoverable: err.recoverable }))');
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
  const e = await vm.evalCode('await agent("pi/x", "p").then(() => "no", (err) => err.message)');
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
      const h = agent("pi/x", "p");
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
  // The host receives BOTH ids: the operation's own registry id (the
  // settlement key) and the founding session id (the dispatch target).
  assert.deepEqual(bridge.steerCalls.map((c) => c.callId), ['c2', 'c3', 'c4']);
  for (const c of bridge.steerCalls) {
    assert.equal(c.sessionId, 'c1', `steer call ${c.action} addresses session ${c.sessionId}`);
  }
  vm.dispose();
});

test('handle validation: followUp/steer need a prompt string; cancel takes none', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({ resolveWith: 'x' });
  const out = value(
    await vm.evalCode(`
      const h = agent("pi/x", "p");
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
  const first = await vm.evalCode('const research = agent("pi/x", "research Y"); "started"');
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
  const out = value(await vm.evalCode('await parallel([() => agent("pi/x", "a"), () => agent("pi/x", "b"), () => agent("pi/x", "c")])'));
  assert.deepEqual(out, ['a', null, 'c']);
  // The swallowed failure was reported through console.warn (the bridge).
  assert.ok(bridge.events.some((e) => e.level === 'warn' && e.line.includes('parallel[1] failed: boom')));
  vm.dispose();
});

test('parallel: non-recoverable failures (recoverable: false) halt the whole parallel', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({ rejectWith: { message: 'halt', recoverable: false } });
  const e = await vm.evalCode('await parallel([() => agent("pi/x", "a"), () => agent("pi/x", "b")]).then(() => "no", (err) => err.message)');
  assert.equal(value(e), 'halt');
  vm.dispose();
});

test('parallel: validates its input (functions, not promises)', async () => {
  const { vm } = await createGuest();
  assert.equal(
    value(await vm.evalCode('await parallel([agent("pi/x", "a")]).then(() => "no", (err) => err.name)')),
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

test('retry: bounded attempts, early stop on until(); no until accepts the first result', async () => {
  const { vm } = await createGuest();
  // Review regression: without `until` the guest ran EVERY attempt — the
  // repository DSL (workflow.ts: `if (!opts.until || opts.until(last))
  // return last`) accepts the FIRST result when no predicate is supplied.
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
  assert.deepEqual(out, { last: 'not yet', tries: 1 });
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
  // Reviewers were spawned as schema-carrying agent calls, all routed
  // through the HOST's configured default backend id (served by
  // '__host_default_backend' — a real registered segment; the v1
  // reserved 'default' sentinel that bypassed registry validation is
  // deleted). The DSL options are exactly { reviewers, threshold, lens }
  // — there is no per-call model option (an invented opts.model was
  // removed in review; dsl.d.ts's verify lets reviewers inherit the
  // run's default model).
  assert.equal(bridge.agentCalls.length, 3);
  for (const call of bridge.agentCalls) {
    const options = JSON.parse(call.optionsJson!);
    assert.equal(options.schema.type, 'object');
    assert.ok(call.task.includes('claim'));
  }
  assert.ok(bridge.agentCalls.every((c) => c.modelSpec === 'claude'), 'reviewers route through the host default backend id');
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
  // Judge prompts carried the rubric, and the graders all routed through
  // the host's configured default backend id (no opts.model in the DSL's
  // { judges, rubric } — the reserved 'default' sentinel is deleted).
  assert.ok(bridge.agentCalls.some((c) => c.task.includes('quality')));
  assert.ok(bridge.agentCalls.every((c) => c.modelSpec === 'claude'), 'graders route through the host default backend id');
  vm.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// The console bridge and $N freezing
// ────────────────────────────────────────────────────────────────────────

test('§4.4: console.log renders ONE joined line per call — args joined with a single space; direct strings print whole', async () => {
  const { vm, bridge } = await createGuest();
  value(await vm.evalCode('console.log("a", "b", "c"); "done"'));
  assert.equal(bridge.events.length, 1);
  assert.equal(bridge.events[0].level, 'log');
  assert.equal(bridge.events[0].line, 'a b c');
  // A directly logged long string prints WHOLE — no upper bound (the
  // Python posture). The length EXCEEDS the deleted 49 488-char
  // emission budget: reintroducing the cap would clip this string, so
  // the assertion is a real over-threshold probe.
  const long = 'x'.repeat(60_000);
  value(await vm.evalCode(`console.log(${JSON.stringify(long)}); "done"`));
  assert.equal(bridge.events[1].line, long);
  vm.dispose();
});

test('§4.4: objects/arrays render to depth 2; deeper levels render as {…}/[…]', async () => {
  const { vm, bridge } = await createGuest();
  value(
    await vm.evalCode(`
      console.log({ a: 1, nested: { b: { c: 2 } }, arr: [1, [2, [3]]] });
      "done"
    `),
  );
  assert.equal(bridge.events[0].line, '{a: 1, nested: {b: {…}}, arr: [1, […]]}');
  // Depth 2 means levels 0 and 1 expand; the level-2 values collapse.
  value(await vm.evalCode('console.log([[1, 2], { x: { y: "deep" } }]); "done"'));
  assert.equal(bridge.events[1].line, "[[1, 2], {x: {…}}]");
  vm.dispose();
});

test('§4.4: collections render their first 20 entries per level, then … +N more', async () => {
  const { vm, bridge } = await createGuest();
  value(
    await vm.evalCode(`
      console.log(Array.from({ length: 25 }, (_, i) => i));
      const o = {}; for (let i = 0; i < 23; i++) o['k' + i] = i;
      console.log(o);
      "done"
    `),
  );
  assert.equal(bridge.events[0].line, '[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, … +5 more]');
  assert.match(bridge.events[1].line, /^\{k0: 0, k1: 1, /);
  assert.ok(bridge.events[1].line.endsWith('… +3 more}'));
  vm.dispose();
});

test('§4.4: nested strings (inside a collection) render head-limited at 200 chars, quoted', async () => {
  const { vm, bridge } = await createGuest();
  const long = 'y'.repeat(500);
  value(await vm.evalCode(`console.log({ long: ${JSON.stringify(long)}, short: 'hi', list: [${JSON.stringify(long)}] }); "done"`));
  const line = bridge.events[0].line;
  assert.ok(line.includes(`long: '${'y'.repeat(200)}…'`), line);
  assert.ok(line.includes("short: 'hi'"), line);
  assert.ok(line.includes(`['${'y'.repeat(200)}…'`), line);
  const belowLimitEmoji = '😀'.repeat(150);
  value(await vm.evalCode(`console.log({ emoji: ${JSON.stringify(belowLimitEmoji)} }); "done"`));
  assert.equal(
    bridge.events[1].line,
    `{emoji: '${belowLimitEmoji}'}`,
    '150 Unicode characters are below the 200-character bound even though they occupy 300 UTF-16 units',
  );
  const aboveLimitEmoji = '😀'.repeat(250);
  value(await vm.evalCode(`console.log({ emoji: ${JSON.stringify(aboveLimitEmoji)} }); "done"`));
  assert.equal(bridge.events[2].line, `{emoji: '${'😀'.repeat(200)}…'}`);
  vm.dispose();
});

test('§4.4: primitives, brands and hostile values render predictably; console.* NEVER throws', async () => {
  const { vm, bridge } = await createGuest();
  value(
    await vm.evalCode(`
      console.log(undefined, null, true, 42, -0, NaN, Infinity, 123n, Symbol('s'));
      console.log(new Date(0), /ab+c/gi, new Map(), new Set(), new WeakMap(), new WeakSet(), new ArrayBuffer(8), new Error('boom'));
      console.warn("warned"); console.error("errored"); console.info("infoed"); console.debug("debugged");
      "done"
    `),
  );
  assert.equal(bridge.events[0].line, 'undefined null true 42 -0 NaN Infinity 123n Symbol');
  assert.equal(bridge.events[1].line, 'Date RegExp Map Set WeakMap WeakSet ArrayBuffer Error: boom');
  assert.deepEqual(bridge.events.slice(2).map((e) => [e.level, e.line]), [
    ['warn', 'warned'],
    ['error', 'errored'],
    ['info', 'infoed'],
    ['debug', 'debugged'],
  ]);
  // A revoked proxy degrades to a marker — console never throws.
  const out = value(
    await vm.evalCode(`
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      let threw = false;
      try { console.log(proxy, { ok: 1 }); } catch (e) { threw = true; }
      threw
    `),
  );
  assert.equal(out, false);
  vm.dispose();
});

test('§4.4: cycles and shared refs collapse to {…}/[…] instead of recursing forever', async () => {
  const { vm, bridge } = await createGuest();
  value(
    await vm.evalCode(`
      const o = { name: 'ring' }; o.self = o;
      const a = [1]; a.push(a);
      console.log(o, a);
      "done"
    `),
  );
  assert.equal(bridge.events[0].line, "{name: 'ring', self: {…}} [1, […]]");
  vm.dispose();
});

test('console.* and pipeline are immune to Array.prototype.slice / Function.prototype.call pollution (captured intrinsics)', async () => {
  // Review regression: console.* gathered its arguments through
  // Array.prototype.slice at call time, so replacing that method with a
  // throwing function made console.log throw — contradicting the bridge
  // contract (console.* NEVER throws). The library captures the
  // slice/call intrinsic pair at installation; pipeline() had the same
  // exposure for its stage list.
  const { vm, bridge } = await createGuest();
  value(await vm.evalCode(`
    Array.prototype.slice = () => { throw new Error('sabotaged slice'); };
    Function.prototype.call = () => { throw new Error('sabotaged call'); };
    "polluted"
  `));
  // console.log still bridges its one joined line.
  value(await vm.evalCode('console.log("a", 42, { k: 1 }); "done"'));
  assert.equal(bridge.events.length, 1);
  assert.equal(bridge.events[0].line, 'a 42 {k: 1}');
  // pipeline still gathers its stage list under the same pollution.
  const out = value(await vm.evalCode('await pipeline([1, 2], (x) => x * 10, (x) => x + 1)'));
  assert.deepEqual(out, [11, 21]);
  vm.dispose();
});

test('sleep(ms) is a guest helper settled by a host-side timer (the VM itself stays timer-free)', async () => {
  const { vm } = await createGuest();
  // The eval suspends on the sleep; the host timer settles it; a later
  // drain resumes the continuation with the elapsed wall clock.
  const started = await vm.evalCode('await sleep(30); 42');
  assert.equal(started.kind, 'pending');
  await new Promise((resolve) => setTimeout(resolve, 60));
  vm.drainJobs();
  assert.equal(value(await vm.evalCode('typeof sleep')), 'function');
  // A second sleep round-trips through the bridge too.
  const again = await vm.evalCode('await sleep(5); "slept"');
  assert.equal(again.kind, 'pending');
  await new Promise((resolve) => setTimeout(resolve, 20));
  vm.drainJobs();
  assert.equal(value(await vm.evalCode('"still alive"')), 'still alive');
  vm.dispose();
});

test('sleep validates its argument synchronously', async () => {
  const { vm } = await createGuest();
  assert.equal(
    value(await vm.evalCode('await sleep(-1).then(() => "no", (err) => err.name)')),
    'TypeError',
  );
  assert.equal(
    value(await vm.evalCode('await sleep("x").then(() => "no", (err) => err.name)')),
    'TypeError',
  );
  vm.dispose();
});

test('workspace()/agents() round-trip the host JSON into plain sliceable values; reset() returns nothing meaningful', async () => {
  const vm = await ReplVm.create();
  const bridge = mockBridge();
  bridge.handlers.workspace = () => JSON.stringify({ bindings: [{ name: 'x', type: 'number', sizeBytes: 8, provenance: 'eval 1', task: null }], inFlight: ['c1'], checkpoints: [{ id: 'c2', question: 'why?' }], diagnostics: { reconcile: null, drainError: null, childrenClosed: false } });
  bridge.handlers.agents = () => JSON.stringify([{ callId: 'c1', modelSpec: 'pi/x', task: 'do it', state: 'running', supportsSteering: true, queuedSteers: 0 }]);
  await installGuestBridge(vm, bridge.handlers);
  const out = value(
    await vm.evalCode(`
      const w = workspace();
      const a = agents();
      ({
        binding: w.bindings[0].name,
        inFlight: w.inFlight[0],
        question: w.checkpoints[0].question,
        drained: w.diagnostics.childrenClosed,
        agent: a[0].callId,
        slice: a.filter((x) => x.state === 'running').length,
        resetReturn: reset(),
      })
    `),
  );
  assert.deepEqual(out, {
    binding: 'x',
    inFlight: 'c1',
    question: 'why?',
    drained: false,
    agent: 'c1',
    slice: 1,
    resetReturn: undefined,
  });
  vm.dispose();
});

test('rejected registry calls carry replCallId on their Errors (§4.6 attribution)', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({ rejectWith: { message: 'boom', replBackend: 'pi' } });
  const out = value(
    await vm.evalCode('await agent("pi/x", "task").then(() => "no", (err) => ({ id: err.replCallId, backend: err.replBackend, message: err.message }))'),
  );
  assert.deepEqual(out, { id: 'c1', backend: 'pi', message: 'boom' });
  vm.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// The reconciliation surface
// ────────────────────────────────────────────────────────────────────────

test('surface.pending() lists parked calls oldest-first with verbatim details', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({}); // park
  value(await vm.evalCode('agent("pi/deepseek-v4-flash-max", "first"); "ok"'));
  value(await vm.evalCode('agent("codex/gpt-5.6-sol", "second", { mode: "read-only" }); "ok"'));
  value(await vm.evalCode('checkpoint("question?"); "ok"'));
  const surface = readGuestSurface(vm)!;
  assert.equal(surface.version, GUEST_LIBRARY_VERSION);
  const pendingList = surface.pending();
  assert.deepEqual(
    pendingList.map((e) => ({ id: e.id, kind: e.kind, detail: e.detail, optionsJson: e.optionsJson, sessionId: e.sessionId, modelSpec: e.modelSpec })),
    [
      { id: 'c1', kind: 'agent', detail: 'first', optionsJson: null, sessionId: 'c1', modelSpec: 'pi/deepseek-v4-flash-max' },
      { id: 'c2', kind: 'agent', detail: 'second', optionsJson: '{"mode":"read-only"}', sessionId: 'c2', modelSpec: 'codex/gpt-5.6-sol' },
      { id: 'c3', kind: 'checkpoint', detail: 'question?', optionsJson: null, sessionId: 'c3', modelSpec: null },
    ],
  );
  vm.dispose();
});

test('surface.settle() settles parked calls (the reconciliation route); first settlement wins', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({}); // park c1
  value(await vm.evalCode('const p = agent("pi/x", "work"); "ok"'));
  const surface = readGuestSurface(vm)!;
  assert.equal(surface.settle('c1', 'resolve', { done: true }), true);
  vm.drainJobs();
  assert.deepEqual(value(await vm.evalCode('await p')), { done: true });
  // Second settlement of the same id is a no-op; unknown ids are false.
  assert.equal(surface.settle('c1', 'resolve', 'again'), false);
  assert.equal(surface.settle('c99', 'resolve', 'x'), false);
  // Rejections through the surface normalize into Errors guest-side.
  bridge.script.push({});
  value(await vm.evalCode('const q = agent("pi/x", "w2"); "ok"'));
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
  value(await vm.evalCode('agent("pi/x", "a"); agent("pi/x", "b"); "ok"'));
  const surface = readGuestSurface(vm)!;
  assert.deepEqual(surface.stats(), {
    version: GUEST_LIBRARY_VERSION,
    callSeq: 2,
    pendingCalls: 2,
  });
  surface.settle('c1', 'resolve', 1);
  assert.equal(surface.stats().pendingCalls, 1);
  vm.dispose();
});

test('the surface survives Map.prototype pollution (captured intrinsics)', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({});
  value(await vm.evalCode('agent("pi/x", "a"); "ok"'));
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

test('snapshot/restore: state, pending registry and version marker travel; callbacks re-register by name', async () => {
  const { vm, bridge } = await createGuest();
  // Park one agent call and one checkpoint; hold state.
  bridge.script.push({}); // park c1
  value(await vm.evalCode('const findings = [1, 2, 3]; const research = agent("pi/deepseek-v4-flash-max", "deep dive"); "ok"'));
  value(await vm.evalCode('const q = checkpoint("still there?"); "ok"'));
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
  assert.equal(pendingList[0].modelSpec, 'pi/deepseek-v4-flash-max', 'model spec survives for re-issue');
  // State survived.
  assert.deepEqual(value(await restored.evalCode('findings')), [1, 2, 3]);
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
  assert.equal(value(await restored.evalCode('await agent("pi/x", "next")')), 'after');
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

test('a host serves a workspace whose resident library is OLDER than the one it ships (evolution discipline)', async () => {
  // The doc's rule: the library carries a version marker and travels
  // inside snapshots, and a host must serve a restored workspace whose
  // resident library is older than the version it currently injects — the
  // resident version stays authoritative (never re-inject over a
  // workspace) and the host re-registers its callbacks by name against
  // whatever version it finds. Simulate the older host: a fresh VM with
  // the library built at version 0.0.1.
  const vm = await ReplVm.create();
  const bridge = mockBridge();
  await installGuestLibraryAtVersion(vm, '0.0.1', bridge);

  // The surface reports the RESIDENT version, not the host's shipped one.
  const surface = readGuestSurface(vm)!;
  assert.equal(surface.version, '0.0.1');
  assert.equal(value(await vm.evalCode(GUEST_VERSION_GLOBAL)), '0.0.1');
  assert.deepEqual(surface.stats(), {
    version: '0.0.1',
    callSeq: 0,
    pendingCalls: 0,
  });

  // The old library's surface is fully usable and host calls work against
  // it (the host-callback surface is backward compatible): agent parks,
  // console events bridge.
  value(await vm.evalCode('agent("pi/x", "work"); "started"'));
  value(await vm.evalCode('console.log({ a: 1 }); "done"'));
  assert.equal(surface.pending().length, 1);
  assert.equal(surface.pending()[0].modelSpec, 'pi/x');
  assert.equal(bridge.events.length, 1);
  assert.deepEqual(bridge.events[0].line, '{a: 1}');

  // The current host's install path over the old library is a no-op: the
  // resident (older) copy stays authoritative.
  await installGuestBridge(vm, mockBridge().handlers);
  assert.equal(readGuestSurface(vm)!.version, '0.0.1', 'the resident version stays authoritative');
  vm.dispose();
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

// ────────────────────────────────────────────────────────────────────────
// Steering reconciliation (the review discipline: a pending steer must be
// snapshot-reconcilable — registry entry and host channel both carry the
// operation's own id AND the founding session id)
// ────────────────────────────────────────────────────────────────────────

test('a pending steer is snapshot-reconcilable: the registry entry records both ids and settle works by registry id', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({}); // park the founding agent call (c1)
  bridge.script.push({}); // park the steer (c2)
  value(await vm.evalCode('const h = agent("pi/x", "work"); "ok"'));
  value(await vm.evalCode('const steered = h.steer("go faster"); "ok"'));

  // The live channel: the host saw the operation's own id AND the session.
  assert.equal(bridge.steerCalls.length, 1);
  assert.equal(bridge.steerCalls[0].callId, 'c2');
  assert.equal(bridge.steerCalls[0].sessionId, 'c1');

  // The manifest: the pending entry omits nothing the host needs to
  // correlate, settle, or re-issue the steer after a restore.
  const surface = readGuestSurface(vm)!;
  const pendingList = surface.pending();
  assert.deepEqual(
    pendingList.map((e) => ({ id: e.id, kind: e.kind, detail: e.detail, sessionId: e.sessionId, modelSpec: e.modelSpec })),
    [
      { id: 'c1', kind: 'agent', detail: 'work', sessionId: 'c1', modelSpec: 'pi/x' },
      { id: 'c2', kind: 'steer', detail: 'steer', sessionId: 'c1', modelSpec: null },
    ],
  );
  // The steer's optionsJson carries the verbatim payload (re-issue needs it).
  assert.deepEqual(JSON.parse(pendingList[1].optionsJson!), { prompt: 'go faster', options: {} });

  // Settlement through the reconciliation route works by the registry id.
  assert.equal(surface.settle('c2', 'resolve', { delivered: 'queued', mode: 'queued' }), true);
  vm.drainJobs();
  assert.deepEqual(value(await vm.evalCode('await steered')), { delivered: 'queued', mode: 'queued' });
  // The founding call is untouched by the steer settlement.
  assert.equal(surface.settle('c1', 'resolve', 'done'), true);
  vm.drainJobs();
  assert.equal(value(await vm.evalCode('await h')), 'done');
  vm.dispose();
});

test('a pending steer survives snapshot/restore with full correlation for re-issue', async () => {
  const { vm, bridge } = await createGuest();
  bridge.script.push({}); // park c1 (founding agent)
  bridge.script.push({}); // park c2 (steer)
  value(await vm.evalCode('const h = agent("pi/x", "work"); "ok"'));
  value(await vm.evalCode('const steered = h.steer("go faster"); "ok"'));
  const snapshot = (getVmShim(vm) as QuickJS).snapshot();
  vm.dispose();

  const restored = await ReplVm.restore(snapshot);
  const restoredBridge = mockBridge();
  registerGuestHostCallbacks(restored, restoredBridge.handlers);
  const surface = readGuestSurface(restored)!;
  const pendingList = surface.pending();
  assert.equal(pendingList.length, 2);
  // The steer entry names its session — the host re-issues to c1's session.
  const steerEntry = pendingList.find((e) => e.kind === 'steer')!;
  assert.equal(steerEntry.id, 'c2');
  assert.equal(steerEntry.sessionId, 'c1');
  assert.equal(steerEntry.detail, 'steer');
  // Reconcile: settle the steer by its registry id (what the host does
  // with the outcome recorded in its call store before the crash).
  assert.equal(surface.settle('c2', 'resolve', { delivered: 'injected' }), true);
  assert.equal(surface.settle('c1', 'resolve', 'done'), true);
  restored.drainJobs();
  assert.deepEqual(value(await restored.evalCode('await steered')), { delivered: 'injected' });
  assert.equal(value(await restored.evalCode('await h')), 'done');
  restored.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// Handle hygiene (the review discipline: a long-lived VM must not
// accumulate guest memory from settled host calls)
// ────────────────────────────────────────────────────────────────────────

test('round 7: __replAwaitIterable over a SYNC iterable preserves AsyncFromSyncIterator value unwrapping — `for await (const x of [Promise.resolve(1), 2])` yields the RESOLVED values `[1, 2]`, never the promise objects (the reviewer\'s repro: the result wrapper resolved with the RAW iterator result, and because the wrapper is an ASYNC iterable the machinery used the value as-is — the promise object leaked through)', async () => {
  const { vm } = await createGuest();
  try {
    // Each eval body is BLOCK-scoped: the realm is shared across evals,
    // and a top-level `const` would redeclare on the next eval. The
    // top-level for-await keeps the script's completion a promise the
    // engine awaits (like `await agent(...)` in the round-trip test).
    const out = value(await vm.evalCode(`{
      const got = [];
      for await (const x of __replAwaitIterable([Promise.resolve(1), 2], 't1')) got.push(x);
      JSON.stringify(got);
    }`));
    assert.equal(out, '[1,2]', 'sync-iterable values are awaited and unwrapped');
    // The unwrap is faithful even when the value settles later (a
    // thenable): the result promise waits for the value's settlement.
    const later = value(await vm.evalCode(`{
      const got = [];
      let n = 0;
      const iter = __replAwaitIterable({
        [Symbol.iterator]: () => ({
          next: () => (n++ === 0 ? { value: Promise.resolve(7), done: false } : { done: true }),
          return: () => ({ value: undefined, done: true }),
        }),
      }, 't1');
      for await (const x of iter) got.push(x);
      JSON.stringify(got);
    }`));
    assert.equal(later, '[7]');
  } finally {
    vm.dispose();
  }
});

test('round 7: __replAwaitIterable ACQUISITION failures propagate exactly once — an observable/throwing `Symbol.asyncIterator` getter runs a SINGLE time and the loop reports its ORIGINAL error (the reviewer\'s repro: the old degrade-to-unwrapped made the for-await machinery acquire the iterable a second time, so the getter ran twice and could report `boom2` instead of native `boom1`)', async () => {
  const { vm } = await createGuest();
  try {
    const out = value(await vm.evalCode(`{
      let n = 0;
      const obj = {
        get [Symbol.asyncIterator]() { n++; if (n === 1) throw new Error('boom1'); throw new Error('boom2'); },
      };
      let err = null;
      try { for await (const x of __replAwaitIterable(obj, 't1')) {} }
      catch (e) { err = e.message; }
      JSON.stringify([err, n]);
    }`));
    assert.equal(out, JSON.stringify(['boom1', 1]), 'the acquisition error propagates, the getter runs once');
    // A present-but-not-callable @@asyncIterator is a TypeError (GetMethod
    // semantics), never a silent fallback to @@iterator.
    const nonCallable = value(await vm.evalCode(`{
      const obj = { [Symbol.asyncIterator]: 42, [Symbol.iterator]: () => ({ next: () => ({ done: true }) }) };
      let err = null;
      try { for await (const x of __replAwaitIterable(obj, 't1')) {} }
      catch (e) { err = e.name + ':' + e.message; }
      err;
    }`));
    assert.ok(String(nonCallable).startsWith('TypeError:'), 'non-callable @@asyncIterator is a TypeError');
  } finally {
    vm.dispose();
  }
});

test('round 7: the await/iterable instrumentation runs on CAPTURED pristine Promise intrinsics — replacing `Promise.prototype.then`, overwriting `Promise.resolve`, or shadowing `Promise` lexically cannot change its semantics (the reviewer\'s repro: replacing `Promise.prototype.then` made the instrumented `await 40` return `99`; the native evaluation returned `40`) and the continuation lease is still set', async () => {
  // Each sabotage case runs in its OWN VM: the mutations are
  // irreversible guest-side (the originals survive only in the
  // library's captured intrinsics), so one realm cannot host two cases.
  // Replaced prototype: the guest-visible then is gone, the
  // instrumentation still mirrors natively and sets the lease.
  {
    const { vm } = await createGuest();
    try {
      const mutated = value(await vm.evalCode(`{
        Promise.prototype.then = function () { return 99; };
        const out = await __replAwait(Promise.resolve(40), 't1');
        JSON.stringify([out, __replLease]);
      }`));
      assert.equal(mutated, JSON.stringify([40, 't1']), 'replaced Promise.prototype.then cannot change the mirror or skip the lease');
    } finally {
      vm.dispose();
    }
  }
  // Overwritten static: the value is minted BEFORE the sabotage (the
  // guest's own later `Promise.resolve` call is guest semantics — the
  // instrumentation's INTERNAL adoption must keep using the captured
  // original), the mirror still resolves natively and the lease is
  // still set.
  {
    const { vm } = await createGuest();
    try {
      const overwritten = value(await vm.evalCode(`{
        const p = Promise.resolve(40);
        Promise.resolve = function () { return 99; };
        const out = await __replAwait(p, 't1');
        JSON.stringify([out, __replLease]);
      }`));
      assert.equal(overwritten, JSON.stringify([40, 't1']), 'overwritten Promise.resolve cannot change the mirror or skip the lease');
    } finally {
      vm.dispose();
    }
  }
  // Shadowed: a block-level lexical Promise (a legitimate user
  // program) — the mirror still works and the lease is still set.
  {
    const { vm } = await createGuest();
    try {
      const shadowed = value(await vm.evalCode(`{
        let out, lease;
        {
          const Promise = { resolve: (v) => v };
          out = await __replAwait(Promise.resolve(40), 't1');
          lease = __replLease;
        }
        JSON.stringify([out, lease]);
      }`));
      assert.equal(shadowed, JSON.stringify([40, 't1']), 'a lexical Promise shadow cannot change the mirror or skip the lease');
    } finally {
      vm.dispose();
    }
  }
  // The iterable wrap is equally isolated: a replaced prototype must
  // not break a for-await over a sync iterable.
  {
    const { vm } = await createGuest();
    try {
      const iterated = value(await vm.evalCode(`{
        const p = Promise.resolve(1);
        Promise.prototype.then = function () { return 99; };
        const got = [];
        for await (const x of __replAwaitIterable([p], 't1')) got.push(x);
        JSON.stringify(got);
      }`));
      assert.equal(iterated, '[1]', 'the iterable wrap mirrors natively under a replaced prototype');
    } finally {
      vm.dispose();
    }
  }
});

test('round 7: __replAwaitIterable over an ASYNC iterable passes result objects through untouched (its value is used as-is — native async iteration semantics; the promise VALUES of async generators are NOT awaited by for-await)', async () => {
  const { vm } = await createGuest();
  try {
    const out = value(await vm.evalCode(`
      const iterable = {
        [Symbol.asyncIterator]: () => {
          let n = 0;
          return {
            next: () => Promise.resolve({ value: ++n, done: n > 2 }),
          };
        },
      };
      const got = [];
      for await (const x of __replAwaitIterable(iterable, 't1')) got.push(x);
      JSON.stringify(got);
    `));
    assert.equal(out, '[1,2]', 'async-iterator result objects pass through untouched');
  } finally {
    vm.dispose();
  }
});

test('5,000 sequential resolved agent calls leave a 2 MiB VM healthy (no handle leak)', async () => {
  // Review regression: GuestCall never disposed its deferred promise
  // handle or the handles returned by marshalValue, so every settled call
  // pinned its promise and the marshalled value — a 2 MiB VM failed after
  // roughly 5,000 sequential resolved agent calls. The bridge now releases
  // both (the promise handle once the trampoline has dupped it, the value
  // handle right after settlement), so memory stays flat.
  const vm = await ReplVm.create({ memoryLimit: 2 * 1024 * 1024 });
  const bridge = mockBridge();
  await installGuestBridge(vm, bridge.handlers);
  for (let i = 0; i < 5000; i++) {
    bridge.script.push({ resolveWith: { i } });
    const out = await vm.evalCode(`await agent("pi/x", "task ${i}")`);
    assert.equal(out.kind, 'value');
    if (out.kind === 'value') assert.equal((out.value as { i: number }).i, i);
  }
  // The VM is fully healthy afterwards — fresh work still completes.
  bridge.script.push({ resolveWith: 'after' });
  assert.equal(value(await vm.evalCode('await agent("pi/x", "after")')), 'after');
  assert.equal(value(await vm.evalCode('1 + 1')), 2);
  vm.dispose();
});

test('unsettled parked calls do not leak either (promise handles are released after return)', async () => {
  const vm = await ReplVm.create({ memoryLimit: 8 * 1024 * 1024 });
  const bridge = mockBridge();
  await installGuestBridge(vm, bridge.handlers);
  // 5,000 parked calls (never settled): each returned promise handle must
  // be released once the guest holds its own reference.
  //
  // Memory-limit note (review round): parked registry entries are LIVE for
  // the VM's lifetime (deleted only on settlement), so 5,000 parked calls
  // have an honest footprint of ~2.09 MB — 99.9% of a 2 MiB limit, a
  // knife-edge where any library-source evolution (even comment growth)
  // tipped the GC/malloc interplay into a hard failure at ~725 calls. The
  // limit is 8 MiB here: the honest footprint (library source + live
  // registry entries) grows with the 0.4.0 library (the §4.4 repr, the
  // eval-plane helpers) and plateaus comfortably under 8 MiB even at
  // 5,000 parked calls —
  // while the leak class this test pins (an undisposed promise handle
  // plus a marshalled value per call, ~400 B/call) is GC-proof: it adds
  // ~2 MB of PINNED guest memory over 5,000 calls, pushing the plateau to
  // ~5.1 MB, and cannot hide in the headroom (the OOM surfaces mid-loop).
  for (let i = 0; i < 5000; i++) {
    const out = await vm.evalCode(`agent("pi/x", "task ${i}"); "started"`);
    assert.equal(out.kind, 'value');
  }
  assert.equal(value(await vm.evalCode('1 + 1')), 2);
  vm.dispose();
});

test('30,000 synchronous host refusals leave a 2 MiB VM healthy (throwing handlers dispose every deferred part)', async () => {
  // Review regression: when a handler threw, the shim converted the throw
  // into a guest error — but the GuestCall's raw promise and both
  // resolving functions were never disposed (`releaseToRealm` was
  // bypassed on the throwing path), so every refusal leaked ~490 bytes of
  // guest memory (promise + 2 resolvers + heap boxes). After 30,000
  // rejected calls the 2 MiB VM was saturated and the next NORMAL agent
  // call failed with `Error: null`. Every throwing-handler path (agent,
  // steer, checkpoint question mode) now disposes all owned parts before
  // re-throwing.
  //
  // The regression is pinned TWO ways, both deterministic: the guest
  // runtime's own memory usage after the refusals (qjs_compute_memory_
  // usage — ~190–250 KB on the fixed code at any refusal volume; 1.6 MB
  // at 3,000 refusals and the 2 MiB cap at 9,000+ on the broken code),
  // and the behavioral probe (a normal agent call still completes).
  const vm = await ReplVm.create({ memoryLimit: 2 * 1024 * 1024 });
  const bridge = mockBridge();
  bridge.handlers.agent = () => {
    throw new Error('refused at dispatch');
  };
  bridge.handlers.steer = () => {
    throw new Error('refused at dispatch');
  };
  bridge.handlers.checkpoint = () => {
    throw new Error('refused at dispatch');
  };
  await installGuestBridge(vm, bridge.handlers);
  // 30,000 refused calls across all three host-callback kinds (100 evals
  // × 100 iterations × 3 calls), every promise rejection handled in-eval.
  for (let i = 0; i < 100; i++) {
    const out = await vm.evalCode(`
      (async () => {
        for (let k = 0; k < 100; k++) {
          const h = agent("pi/x", "t" + k);
          const s = h.steer("go");
          const q = checkpoint("q?");
          await Promise.all([h, s, q].map((p) => p.then(() => "no", (e) => e.message)));
        }
      })()
    `);
    assert.equal(out.kind, 'value');
  }
  // The guest runtime's memory stayed flat: far below the 2 MiB limit
  // (the broken code saturates the cap — qjs_memory_usage() reads
  // 2,092,244 there; the fixed code holds ~190–250 KB).
  const usageBytes = vmMemoryUsage(vm);
  assert.ok(
    usageBytes < 1024 * 1024,
    `guest memory after 30,000 refusals must stay below 1 MiB, got ${usageBytes} bytes`,
  );
  // A NORMAL agent call still works after the mass refusals (the review's
  // exact failure mode) — swap in working handlers via the
  // re-registration path, and the VM is fully healthy.
  const working = mockBridge();
  working.script.push({ resolveWith: 'after' });
  registerGuestHostCallbacks(vm, working.handlers);
  assert.equal(value(await vm.evalCode('await agent("pi/x", "after")')), 'after');
  assert.equal(value(await vm.evalCode('1 + 1')), 2);
  vm.dispose();
});

/**
 * Guest runtime memory usage in bytes (mallocSize from the runtime's
 * memory-usage statistics). Read through the shim's getMemoryUsage(),
 * which allocates the COMPLETE 26-int64 (208-byte) JSMemoryUsage
 * structure before qjs_compute_memory_usage writes into it, reads every
 * field back, and frees it — a raw 4-byte buffer would let the C write
 * 208 bytes past its end, corrupting adjacent WASM memory and
 * invalidating the very measurement it feeds (review regression: the
 * corruption made the deterministic refusal-memory assertion read
 * garbage).
 */
function vmMemoryUsage(vm: ReplVm): number {
  return (getVmShim(vm) as QuickJS).getMemoryUsage().mallocSize;
}
