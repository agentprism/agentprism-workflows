/**
 * Engine-level tests: VM instantiation (shipped wasm), eval semantics,
 * the job drain, memory limits, and per-eval interrupts. Deterministic
 * and credential-free; every case runs against the `quickjs-wasi` npm
 * package's shipped `quickjs.wasm` binary (the doc's mapping table: the
 * package used as-is, including its binary).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EvalFlags, QuickJS } from 'quickjs-wasi';

import { DrainJobError, ReplVm, loadShippedWasm } from '../src/index.js';
import { getVmShim } from '../src/vm.js';
import { JSValueHandle, type QuickJS } from 'quickjs-wasi';

type VmOptions = NonNullable<Parameters<typeof ReplVm.create>[0]>;

async function vm(options?: VmOptions): Promise<ReplVm> {
  return ReplVm.create(options);
}

function describe(outcome: unknown): string {
  try {
    return JSON.stringify(outcome, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
  } catch {
    return String(outcome);
  }
}

function value(outcome: Awaited<ReturnType<ReplVm['evalCode']>>): unknown {
  assert.equal(outcome.kind, 'value', `expected value outcome, got ${describe(outcome)}`);
  return outcome.value;
}

function error(outcome: Awaited<ReturnType<ReplVm['evalCode']>>): {
  name: string;
  message: string;
  interrupted: boolean;
  outOfMemory: boolean;
} {
  assert.equal(outcome.kind, 'error', `expected error outcome, got ${describe(outcome)}`);
  return outcome.error;
}

test('loadShippedWasm resolves the npm package binary and compiles it', async () => {
  const module = await loadShippedWasm();
  assert.ok(module instanceof WebAssembly.Module);
  // Process-wide cache: repeated loads return the same compiled module.
  assert.equal(module, await loadShippedWasm());
});

test('eval round-trip: numbers, strings, booleans, undefined, bigint, null', async () => {
  using v = await vm();
  assert.equal(value(await v.evalCode('1 + 2')), 3);
  assert.equal(value(await v.evalCode('6 * 7')), 42);
  assert.equal(value(await v.evalCode('"hello" + " world"')), 'hello world');
  assert.equal(value(await v.evalCode('true && !false')), true);
  assert.equal(value(await v.evalCode('undefined')), undefined);
  assert.equal(value(await v.evalCode('null')), null);
  assert.equal(value(await v.evalCode('10n ** 3n')), 1000n);
});

test('eval round-trip: multi-statement scripts complete with the last expression', async () => {
  using v = await vm();
  // REPL-critical multi-statement semantics (the harness's pinned shape).
  assert.equal(value(await v.evalCode('1; 2; 6 * 7')), 42);
});

test('eval round-trip: object and array completions via trap-free reads', async () => {
  using v = await vm();
  assert.deepEqual(value(await v.evalCode('({ a: 1, b: "two", c: [1, 2, 3] })')), {
    a: 1,
    b: 'two',
    c: [1, 2, 3],
  });
  assert.deepEqual(value(await v.evalCode('[1, "x", true, null]')), [1, 'x', true, null]);
});

test('state persists across evals: bindings live in the VM, not in a transcript', async () => {
  using v = await vm();
  assert.equal(value(await v.evalCode('let counter = 41; const label = "n"')), undefined);
  assert.equal(value(await v.evalCode('counter + 1')), 42);
  assert.equal(value(await v.evalCode('`${label}=${counter}`')), 'n=41');
  // var hoists to globalThis, like a REPL.
  assert.equal(value(await v.evalCode('var hoisted = 7; hoisted * 6')), 42);
  assert.equal(value(await v.evalCode('globalThis.hoisted')), 7);
});

test('determinism is intact: Date.now() and Math.random() work natively in the realm (the doc exclusion list — no frozen replacements, no journal)', async () => {
  using v = await vm();
  // Date.now(): a REAL timestamp, not a frozen/zeroed replacement — two calls
  // in one eval observe real time passing, and the value round-trips.
  const stamp = value(await v.evalCode('Date.now()'));
  assert.equal(typeof stamp, 'number');
  assert.ok(stamp > 1_500_000_000_000, 'a plausible 2020+ epoch millis value');
  assert.ok(value(await v.evalCode('Date.now()')) >= stamp, 'time never runs backwards');
  // Math.random(): a REAL [0,1) value, not a deterministic replacement — a
  // fresh draw differs from the previous one (a fixed-seed replacement would
  // make the assert fail; a per-call counter is astronomically unlikely to
  // collide once).
  const first = value(await v.evalCode('Math.random()'));
  const second = value(await v.evalCode('Math.random()'));
  assert.equal(typeof first, 'number');
  assert.ok(first >= 0 && first < 1);
  assert.ok(second >= 0 && second < 1);
  assert.notEqual(first, second);
});

test('top-level await is accepted; microtask-only awaits resolve in-eval', async () => {
  using v = await vm();
  assert.equal(value(await v.evalCode('await Promise.resolve(42)')), 42);
  assert.equal(value(await v.evalCode('const a = await Promise.resolve(6); a * 7')), 42);
  assert.equal(
    value(await v.evalCode('let x = 0; await Promise.resolve().then(() => { x = 42 }); x')),
    42,
  );
});

test('top-level return stays a syntax error (the doc pins this)', async () => {
  using v = await vm();
  const e = error(await v.evalCode('return 1'));
  assert.equal(e.name, 'SyntaxError');
  assert.match(e.message, /return/);
});

test('syntax errors report name and message, VM stays usable', async () => {
  using v = await vm();
  const e = error(await v.evalCode('const ='));
  assert.equal(e.name, 'SyntaxError');
  assert.ok(e.message.length > 0);
  assert.equal(value(await v.evalCode('1 + 1')), 2);
});

test('synchronous parse failures never invoke guest getters (trap-free error boundary)', async () => {
  using v = await vm();
  // Adversarial regression (review): quickjs-wasi's `evalCode()` wraps a
  // synchronous parse failure in a `JSException` whose constructor
  // performs guest-visible `[[Get]]` reads of name/message/stack — a
  // getter installed on `SyntaxError.prototype.name` executed during
  // error reporting, before any host catch. The engine's eval path must
  // never construct that exception: descriptor reads only.
  assert.equal(
    value(
      await v.evalCode(`
        globalThis.__traps = 0;
        for (const key of ['name', 'message', 'stack']) {
          Object.defineProperty(SyntaxError.prototype, key, {
            configurable: true,
            get() { globalThis.__traps++; return 'trapped'; },
          });
        }
        'installed';
      `),
    ),
    'installed',
  );
  const e = error(await v.evalCode('const ='));
  // The real message is an own data property of the SyntaxError instance
  // and is still reported; the accessor `name` (and stack) are skipped,
  // never invoked, so the name falls back to 'Error'.
  assert.equal(e.name, 'Error');
  assert.ok(e.message.length > 0);
  assert.equal(value(await v.evalCode('globalThis.__traps')), 0, 'no guest getter ran');
  assert.equal(value(await v.evalCode('1 + 1')), 2);
});

test('rejected completions never invoke guest getters on the error', async () => {
  using v = await vm();
  value(
    await v.evalCode(`
      globalThis.__traps = 0;
      Object.defineProperty(TypeError.prototype, 'name', {
        configurable: true,
        get() { globalThis.__traps++; return 'TypeError'; },
      });
      'installed';
    `),
  );
  const e = error(await v.evalCode('const err = new TypeError("boom"); throw err'));
  assert.equal(e.message, 'boom');
  assert.equal(e.name, 'Error', 'accessor name is skipped, never invoked');
  assert.equal(value(await v.evalCode('globalThis.__traps')), 0, 'no guest getter ran');
});

test('a thrown proxy is reported trap-free (no descriptor/prototype traps)', async () => {
  using v = await vm();
  // Adversarial regression (review): a thrown proxy executed three guest
  // traps (one per name/message/stack descriptor read). Every descriptor
  // and prototype inspection must be guarded with `isProxy` first, and
  // the proxy reports a trap-free marker.
  const e = error(
    await v.evalCode(`
      globalThis.__traps = 0;
      const p = new Proxy({}, {
        getOwnPropertyDescriptor(t, k) { globalThis.__traps++; return Reflect.getOwnPropertyDescriptor(t, k); },
        getPrototypeOf(t) { globalThis.__traps++; return Reflect.getPrototypeOf(t); },
        get(t, k) { globalThis.__traps++; return Reflect.get(t, k); },
        ownKeys(t) { globalThis.__traps++; return Reflect.ownKeys(t); },
      });
      throw p;
    `),
  );
  assert.equal(e.name, 'Error');
  assert.equal(e.message, '[Proxy]');
  assert.match(e.stack ?? '', /<repl>:\d+:\d+/, 'the proxy throw keeps its submitted-code frame');
  assert.equal(value(await v.evalCode('globalThis.__traps')), 0, 'no proxy trap ran');
});

test('an error whose prototype is a proxy is reported without firing its traps', async () => {
  using v = await vm();
  // The error object itself is not a proxy, but its prototype is
  // (`Object.setPrototypeOf` works on errors) — reading `name` off that
  // prototype would fire the proxy's `getOwnPropertyDescriptor` trap.
  const e = error(
    await v.evalCode(`
      globalThis.__traps = 0;
      const proto = new Proxy({ name: 'TypeError' }, {
        getOwnPropertyDescriptor(t, k) { globalThis.__traps++; return Reflect.getOwnPropertyDescriptor(t, k); },
      });
      const err = new TypeError('boom');
      Object.setPrototypeOf(err, proto);
      throw err;
    `),
  );
  assert.equal(e.message, 'boom');
  assert.equal(e.name, 'Error', 'proxy-prototype name is never read');
  assert.equal(value(await v.evalCode('globalThis.__traps')), 0, 'no proxy trap ran');
});

test('an eval suspended on an unsettled promise reports pending, with no fabricated value', async () => {
  using v = await vm();
  const outcome = await v.evalCode('const gate = new Promise(() => {}); await gate; "never"');
  assert.equal(outcome.kind, 'pending');
  // The VM stays fully usable; the suspended continuation is ordinary state.
  assert.equal(value(await v.evalCode('1 + 1')), 2);
  // Unawaited started handles also complete as the value being a promise.
  assert.equal(value(await v.evalCode('new Promise(() => {})')), '[Promise]');
});

test('thrown values report trap-free error info (name via prototype read)', async () => {
  using v = await vm();
  const e = error(await v.evalCode('throw new TypeError("nope")'));
  assert.equal(e.name, 'TypeError');
  assert.equal(e.message, 'nope');
  assert.equal(e.interrupted, false);
  assert.equal(e.outOfMemory, false);
  const e2 = error(await v.evalCode('throw new Error("boom")'));
  assert.equal(e2.name, 'Error');
  assert.equal(e2.message, 'boom');
  // Primitive throws surface with their string conversion.
  const e3 = error(await v.evalCode('throw "plain string"'));
  assert.equal(e3.name, 'Error');
  assert.equal(e3.message, 'plain string');
  assert.match(e3.stack ?? '', /<repl>:1:\d+/, 'a thrown string keeps the submitted-code line');
  const e4 = error(await v.evalCode('\nthrow null'));
  assert.equal(e4.message, 'null');
  assert.match(e4.stack ?? '', /<repl>:2:\d+/, 'a thrown null keeps the submitted-code line');
  const e5 = error(await v.evalCode('\nthrow undefined'));
  assert.equal(e5.message, 'undefined');
  assert.match(e5.stack ?? '', /<repl>:2:\d+/, 'a thrown undefined keeps the submitted-code line');
});

test('rejected top-level awaits report the raw thrown value', async () => {
  using v = await vm();
  const e = error(await v.evalCode('await Promise.reject(new RangeError("too big"))'));
  assert.equal(e.name, 'RangeError');
  assert.equal(e.message, 'too big');
});

test('the completion unwrap is trap-free: Object.prototype.value pollution cannot hijack results', async () => {
  using v = await vm();
  // R69's regression: a plain [[Get]] unwrap of the `{ value }` completion
  // wrapper lets a guest pollute every eval result. The engine unwraps via
  // own-property-descriptor reads; the pollution must not leak through.
  assert.equal(value(await v.evalCode('Object.prototype.value = "polluted"')), 'polluted');
  const result = value(await v.evalCode('({ real: 42 })'));
  assert.deepEqual(result, { real: 42 });
  assert.equal(value(await v.evalCode('globalThis.value')), 'polluted');
});

test('completion reads never invoke guest getters (trap-free rendering)', async () => {
  using v = await vm();
  const result = value(
    await v.evalCode(
      'let calls = 0; globalThis.calls = 0; ({ get secret() { globalThis.calls++; return "gotcha" }, plain: 1 })',
    ),
  );
  assert.deepEqual(result, { plain: 1 }); // accessors are skipped, never invoked
  assert.equal(value(await v.evalCode('globalThis.calls')), 0);
});

test('job drain: microtasks queued by an eval settle within the drain', async () => {
  using v = await vm();
  assert.equal(
    value(
      await v.evalCode(`
        let acc = 0;
        for (let i = 0; i < 500; i++) Promise.resolve().then(() => { acc++ });
        "queued"
      `),
    ),
    'queued',
  );
  // Every queued microtask ran inside the eval's drain.
  assert.equal(value(await v.evalCode('acc')), 500);
});

test('job drain: drainJobs() is the standalone settlement drain', async () => {
  using v = await vm();
  // Nothing pending: a drain is a no-op returning 0.
  assert.equal(value(await v.evalCode('"idle"')), 'idle');
  assert.equal(v.drainJobs(), 0);
  // A suspended top-level await leaves nothing runnable in the queue.
  const pending = await v.evalCode('const gate = new Promise(() => {}); await gate; 1');
  assert.equal(pending.kind, 'pending');
  assert.equal(v.drainJobs(), 0);
  // And the VM keeps working after both.
  assert.equal(value(await v.evalCode('1 + 1')), 2);
});

test('job-drain errors never invoke guest getters (trap-free drain boundary)', async () => {
  using v = await vm();
  // Adversarial regression: quickjs-wasi's `executePendingJobs()` renders
  // a failed job's exception through `toString()`, which executes guest
  // code (a getter on `Error.prototype.name` fires while the drain error
  // is reported). The engine's drain reads the exception trap-free.
  value(
    await v.evalCode(`
      globalThis.__traps = 0;
      Object.defineProperty(Error.prototype, 'name', {
        configurable: true,
        get() { globalThis.__traps++; return 'Error'; },
      });
      'installed';
    `),
  );
  const e = error(
    await v.evalCode('queueMicrotask(() => { throw new Error("job boom") }); "queued"'),
  );
  assert.equal(e.message, 'job boom');
  assert.equal(value(await v.evalCode('globalThis.__traps')), 0, 'no guest getter ran');
  // The VM stays usable after the drain failure.
  assert.equal(value(await v.evalCode('1 + 1')), 2);
});

test('repeated syntax errors do not accumulate guest memory (exception handles are freed)', async () => {
  // Adversarial regression (review): the caught `JSException` and its
  // owned handle were never disposed, and a 1 MiB VM exhausted after
  // ~4,018 syntax errors — even `1 + 1` then returned a null error. The
  // exception value must be freed immediately, so the VM is long-lived.
  using v = await vm({ memoryLimit: 1024 * 1024 });
  for (let i = 0; i < 20_000; i++) {
    const e = error(await v.evalCode('const ='));
    assert.equal(e.name, 'SyntaxError');
  }
  assert.equal(value(await v.evalCode('1 + 1')), 2);
});

test('repeated accessor-valued completions do not accumulate guest memory (accessor handles are freed)', async () => {
  // Adversarial regression (review): accessor descriptors own `get`/`set`
  // handles that were never disposed, exhausting a 1 MiB VM after ~3,128
  // accessor-valued completions. Both handles must be freed.
  using v = await vm({ memoryLimit: 1024 * 1024 });
  for (let i = 0; i < 20_000; i++) {
    const out = await v.evalCode('({ get secret() { return "x" } })');
    assert.equal(out.kind, 'value');
    if (out.kind === 'value') assert.deepEqual(out.value, {}, 'accessor is skipped');
  }
  assert.equal(value(await v.evalCode('1 + 1')), 2);
});

test('resolved evals do not accumulate completion memory (wrapper + discarded handles are freed)', async () => {
  // Adversarial regression (review): the resolved completion path
  // returned the unwrapped value handle while RETAINING the
  // engine-created `{ value }` wrapper (the finally condition never
  // disposed it when the completion was kept), and the public evalCode()
  // discarded any returned completion handle without disposing it. Every
  // Broker.eval (rejectionBridge: true) took both paths, and an
  // adversarial 2 MiB VM probe died at eval ~19,346 with `Error: null`;
  // 50,000 ordinary evals stayed healthy. Rejection bridging is now
  // separate from completion ownership: the wrapper is disposed on the
  // unwrap path and evalCode disposes the handle it discards, so the VM
  // is long-lived under both entries.
  using v = await vm({ memoryLimit: 2 * 1024 * 1024 });
  for (let i = 0; i < 20_000; i++) {
    // The broker entry: keepCompletion + bridge, the caller disposes the
    // returned completion handle.
    const kept = v.evalCodeWithCompletion('({ n: ' + i + ' })', { rejectionBridge: true });
    assert.equal(kept.outcome.kind, 'value');
    if (kept.completion !== undefined) (kept.completion as JSValueHandle).dispose();
    // The public entry: the bridge is armed but the completion handle is
    // discarded by evalCode itself — it must dispose it.
    const dropped = await v.evalCode('({ m: ' + i + ' })', { rejectionBridge: true });
    assert.equal(dropped.kind, 'value');
    if (dropped.kind === 'value') assert.deepEqual(dropped.value, { m: i });
  }
  // A suspended eval with the bridge attached also stays healthy (the
  // bridge attaches to the pending completion — no fabricated value).
  const pending = await v.evalCode('const gate = new Promise(() => {}); await gate; 1', { rejectionBridge: true });
  assert.equal(pending.kind, 'pending');
  assert.equal(value(await v.evalCode('1 + 1')), 2, 'the VM is healthy after 40,000 resolved evals plus a suspended one');
});

test('memory limit: a per-VM limit turns oversized allocations into out-of-memory errors', async () => {
  using v = await vm({ memoryLimit: 1024 * 1024 });
  assert.equal(v.memoryLimit, 1024 * 1024);
  const e = error(await v.evalCode("'x'.repeat(64 * 1024 * 1024)"));
  assert.equal(e.name, 'InternalError');
  assert.equal(e.message, 'out of memory');
  assert.equal(e.outOfMemory, true);
  // The VM remains usable after the failed allocation.
  assert.equal(value(await v.evalCode('1 + 1')), 2);
});

test('memory limit: independent per-VM limits (engine posture: memoryLimit per VM)', async () => {
  using tight = await vm({ memoryLimit: 1024 * 1024 });
  using loose = await vm({ memoryLimit: 256 * 1024 * 1024 });
  const e = error(await tight.evalCode("'y'.repeat(64 * 1024 * 1024)"));
  assert.equal(e.outOfMemory, true);
  // The same allocation fits in the loose VM.
  assert.equal(value(await loose.evalCode("'y'.repeat(64 * 1024 * 1024).length")), 64 * 1024 * 1024);
  assert.equal(value(await tight.evalCode('2 + 2')), 4);
});

test('per-eval interrupt: a runaway eval is broken with the VM still usable after', async () => {
  using v = await vm();
  let checks = 0;
  const outcome = await v.evalCode('while (true) {}', {
    interruptHandler: () => ++checks > 100,
  });
  const e = error(outcome);
  assert.equal(e.name, 'InternalError');
  assert.equal(e.message, 'interrupted');
  assert.equal(e.interrupted, true);
  // The VM stays usable — this is the "break a runaway eval" contract.
  assert.equal(value(await v.evalCode('1 + 1')), 2);
  assert.equal(value(await v.evalCode('const after = "alive"; after')), 'alive');
});

test('per-eval interrupt: a runaway microtask loop is broken during the drain', async () => {
  using v = await vm();
  // The interrupt budget is instruction-based (quickjs's built-in check
  // interval), so a small budget against a tiny loop body keeps the drain
  // short while still firing inside a drained job.
  let checks = 0;
  const outcome = await v.evalCode('(async () => { let i = 0; while (true) { i++; await 0 } })()', {
    interruptHandler: () => ++checks > 3,
  });
  // The interrupt fired inside a drained job: the drain surfaces it as a
  // job error (the harness's pinned "JobError from the drain" shape).
  const e = error(outcome);
  assert.equal(e.interrupted, true);
  // VM still usable, including new async work.
  assert.equal(value(await v.evalCode('await Promise.resolve(42)')), 42);
});

test('interrupt handlers never leak across evals', async () => {
  using v = await vm();
  const e = error(
    await v.evalCode('while (true) {}', {
      interruptHandler: () => true,
    }),
  );
  assert.equal(e.interrupted, true);
  // The next eval runs without a handler — no stale interrupt fires.
  assert.equal(value(await v.evalCode('6 * 7')), 42);
});

test('interrupt handlers are per-eval: the same VM serves different handlers', async () => {
  using v = await vm();
  let a = 0;
  let b = 0;
  const e1 = error(
    await v.evalCode('while (true) {}', {
      interruptHandler: () => ++a > 500,
    }),
  );
  assert.equal(e1.interrupted, true);
  assert.ok(a >= 500);
  const e2 = error(
    await v.evalCode('while (true) {}', {
      interruptHandler: () => ++b > 100,
    }),
  );
  assert.equal(e2.interrupted, true);
  assert.ok(b >= 100 && b < a, 'second handler got its own budget');
});

test('dispose: the VM is torn down and refuses further use', async () => {
  const v = await vm();
  assert.equal(value(await v.evalCode('1 + 1')), 2);
  v.dispose();
  assert.equal(v.isDisposed, true);
  await assert.rejects(v.evalCode('1'), /disposed/);
  assert.throws(() => v.drainJobs(), /disposed/);
  // Idempotent.
  v.dispose();
});

test('the shipped binary round-trips as the public wasm type (loadShippedWasm → create)', async () => {
  using v = await vm({ wasm: await loadShippedWasm() });
  assert.equal(value(await v.evalCode('6 * 7')), 42);
  assert.equal(v.memoryLimit, ReplVm.DEFAULT_MEMORY_LIMIT);
});

test('a failing own-descriptor read never constructs JSException and leaves the VM usable', async () => {
  using v = await vm();
  // Adversarial regression (review): `JSValueHandle.getOwnPropertyDescriptor()`
  // throws a `JSException` when the C descriptor read fails, and that
  // constructor performs guest-visible `[[Get]]` reads of name/message/stack
  // on the exception value — a getter on `SyntaxError.prototype.name` would
  // execute during error construction, before any host catch. The engine's
  // raw descriptor path must take the failed read's exception out of the
  // runtime and free it without ever constructing a `JSException`.
  value(
    await v.evalCode(`
      globalThis.__traps = 0;
      for (const key of ['name', 'message', 'stack']) {
        Object.defineProperty(SyntaxError.prototype, key, {
          configurable: true,
          get() { globalThis.__traps++; return 'trapped'; },
        });
      }
      'installed';
    `),
  );
  // Drive the raw exports directly — the same surface the engine drives —
  // and make every descriptor read fail the way the C engine fails under
  // an allocation edge: the export returns the exception sentinel and a
  // real exception value lands in the runtime slot. Running a real failing
  // `qjs_eval` per read keeps the sentinel and the runtime exception
  // genuine. The WASM exports object is frozen with non-configurable data
  // properties (a Proxy `get` trap cannot override them), so the shim's
  // `exports` field (a plain TS-private property) is swapped for an object
  // that shadows the descriptor export and delegates everything else to
  // the real exports.
  const qjs = (v as unknown as { vm: QuickJS }).vm;
  const originalExports = qjs._getExports();
  const patched = Object.create(originalExports);
  Object.defineProperty(patched, 'qjs_get_own_property_descriptor', {
    configurable: true,
    writable: true,
    value: () => {
      const code = qjs._writeString('const =');
      const fn = qjs._writeString('<fail>');
      const sentinel = originalExports.qjs_eval(code.ptr, code.len, fn.ptr, EvalFlags.TYPE_GLOBAL);
      originalExports.wasm_free(code.ptr);
      originalExports.wasm_free(fn.ptr);
      return sentinel;
    },
  });
  (qjs as unknown as { exports: typeof originalExports }).exports = patched;
  try {
    const outcome = await v.evalCode('({ a: 1 })');
    // Every descriptor read failed and read as absent; the completion
    // renders as an empty object instead of crashing or fabricating data.
    assert.equal(outcome.kind, 'value');
    if (outcome.kind === 'value') assert.deepEqual(outcome.value, {});
  } finally {
    (qjs as unknown as { exports: typeof originalExports }).exports = originalExports;
  }
  // No `JSException` was constructed: none of the getters ran.
  assert.equal(value(await v.evalCode('globalThis.__traps')), 0, 'no guest getter ran');
  // The failed reads took the runtime exception out each time — no sticky
  // exception poisons the VM.
  assert.equal(value(await v.evalCode('1 + 1')), 2);
});

test('standalone settlement drains arm their own interrupt handler (delayed continuation interruption)', async () => {
  using v = await vm();
  // Two runaway continuations, interrupted mid-drain by the per-eval
  // handler: the drain stops at the first failed job, so at least one
  // runaway continuation stays queued in the VM. Its per-eval handler is
  // gone with the eval — a later settlement drain would resume the loop
  // with no interrupt protection unless the drain carries its own signal.
  let evalChecks = 0;
  const outcome = await v.evalCode(
    `
      for (let k = 0; k < 2; k++) {
        (async () => { let i = 0; while (true) { i++; await 0 } })();
      }
      'queued';
    `,
    { interruptHandler: () => ++evalChecks > 3 },
  );
  const e = error(outcome);
  assert.equal(e.interrupted, true);

  // Drain the leftovers with a per-drain handler: each failed job throws a
  // `DrainJobError` reporting the interrupt; the loop consumes every queued
  // continuation and terminates. (Without a handler, this drain would run
  // the leftover runaway forever.)
  let drainChecks = 0;
  let interruptedDrains = 0;
  for (;;) {
    let n = 0;
    try {
      n = v.drainJobs({ interruptHandler: () => ++drainChecks > 1 });
    } catch (err) {
      assert.ok(err instanceof DrainJobError, 'drain failure is a DrainJobError');
      assert.equal(err.info.interrupted, true);
      interruptedDrains++;
      continue;
    }
    if (n === 0) break;
  }
  assert.ok(
    interruptedDrains >= 1,
    'a leftover runaway continuation was interrupted by the standalone drain',
  );
  // The per-drain handler is gone too — nothing leaked.
  assert.equal(v.drainJobs(), 0);
  assert.equal(value(await v.evalCode('1 + 1')), 2);
  assert.equal(value(await v.evalCode('await Promise.resolve(42)')), 42);
});

test('dispose cannot race an in-flight eval: settled and suspended evals complete first', async () => {
  // Review regression: the completion read used to yield through an
  // already-settled host promise, so `const p = ws.eval('6*7');
  // ws.dispose(); await p` rejected with `TypeError: Cannot read
  // properties of null (reading 'qjs_is_proxy')` once the WASM exports
  // were nulled. Eval completion is now synchronous: the eval finishes
  // before `dispose` even runs, and both outcomes survive.
  const v = await vm();
  const settled = v.evalCode('6 * 7');
  v.dispose();
  const settledOutcome = await settled;
  assert.equal(settledOutcome.kind, 'value');
  if (settledOutcome.kind === 'value') assert.equal(settledOutcome.value, 42);

  const v2 = await vm();
  const suspended = v2.evalCode('const gate = new Promise(() => {}); await gate; "never"');
  v2.dispose();
  const suspendedOutcome = await suspended;
  assert.equal(suspendedOutcome.kind, 'pending', 'suspended eval reports pending, not a crash');

  const v3 = await vm();
  const failed = v3.evalCode('const =');
  v3.dispose();
  const failedOutcome = await failed;
  assert.equal(failedOutcome.kind, 'error');
  if (failedOutcome.kind === 'error') assert.equal(failedOutcome.error.name, 'SyntaxError');
});

test('concurrent evals never leak interrupt handlers across the batch', async () => {
  using v = await vm();
  // Review regression: two overlapping evals restored the interrupt slot
  // out of nesting order and left the first handler armed indefinitely; a
  // later standalone drain then inherited the unrelated handler. Eval is
  // now synchronous, so the calls serialize — this pins that the slot
  // save/restore leaves nothing behind under a concurrent call pattern.
  const budgets = new Array<number>(32).fill(0);
  const results = await Promise.all(
    budgets.map((_, k) =>
      v.evalCode('while (true) {}', { interruptHandler: () => ++budgets[k] > k + 1 }),
    ),
  );
  for (let k = 0; k < results.length; k++) {
    const e = error(results[k]);
    assert.equal(e.interrupted, true);
    assert.ok(budgets[k] >= k + 1, `eval ${k} was interrupted by its own handler`);
  }
  // No handler survives the batch: a no-handler eval runs to completion
  // and a no-handler drain is clean.
  assert.equal(value(await v.evalCode('6 * 7')), 42);
  assert.equal(v.drainJobs(), 0);
});

test('thrown symbols render the bare brand — the description is not readable trap-free', async () => {
  using v = await vm();
  // Review regression: the primitive error-rendering default branch called
  // `toNumber()` on symbols, so `throw Symbol('x')` reported message `NaN`
  // — a fabricated conversion. The honest rendering is the bare brand
  // `Symbol` (FORMAT.md §5.7): the description sits behind
  // `qjs_get_symbol_description`, which invokes guest `Symbol.keyFor` — a
  // forbidden seam (FORMAT.md §1.1), because a guest that replaces
  // `Symbol.keyFor` could forge the classification. The next test pins
  // that the seam is never reached.
  assert.equal(error(await v.evalCode('throw Symbol("boom")')).message, 'Symbol');
  assert.equal(error(await v.evalCode('throw Symbol()')).message, 'Symbol');
  assert.equal(error(await v.evalCode('throw Symbol("")')).message, 'Symbol');
  assert.equal(error(await v.evalCode('throw Symbol.for("shared")')).message, 'Symbol');
  // Rejected top-level awaits surface the same conversion.
  assert.equal(error(await v.evalCode('await Promise.reject(Symbol("rejected"))')).message, 'Symbol');
  // The VM stays usable.
  assert.equal(value(await v.evalCode('1 + 1')), 2);
});

test('a guest that replaces Symbol.keyFor cannot influence error rendering (no forbidden seam)', async () => {
  using v = await vm();
  // The FORMAT.md §1.1 seam: reading a symbol's description calls guest
  // `Symbol.keyFor` through the binary. The engine must never reach it —
  // a hostile guest swaps it for a trap counter and throws symbols; the
  // rendered message must be the bare brand and the counter must stay 0.
  value(
    await v.evalCode(`
      globalThis.__keyForTraps = 0;
      Symbol.keyFor = function () { globalThis.__keyForTraps++; return 'FORGED'; };
      try {
        Object.defineProperty(Symbol.prototype, 'description', {
          configurable: true,
          get() { globalThis.__keyForTraps++; return 'FORGED'; },
        });
      } catch (_e) { /* non-configurable on this build — keyFor is the seam anyway */ }
      'installed'
    `),
  );
  const e = error(await v.evalCode('throw Symbol("secret")'));
  assert.equal(e.message, 'Symbol');
  assert.equal(value(await v.evalCode('globalThis.__keyForTraps')), 0, 'Symbol.keyFor/description never ran');
});

test('a value GETTER on Object.prototype empties the completion wrapper — without running guest code (engine quirk, pinned)', async () => {
  using v = await vm();
  // Discovered during phase B: quickjs-ng's async-eval completion wrapper
  // (`{ value: … }`) comes out EMPTY once `Object.prototype.value` is
  // rebound to a GETTER — the engine's own wrapper creation is
  // prototype-sensitive for exactly this key. The engine never executes
  // the getter (verified with a counter); the completion read degrades
  // honestly to `{}` (the trap-free fallback renders the wrapper as-is
  // rather than fabricating a value), and the VM stays fully usable.
  // The install eval's own completion already degrades (the pollution is
  // installed mid-eval, so its wrapper comes out empty) — run it, then
  // assert the degradation and the trap-freedom of subsequent evals.
  await v.evalCode(`
    globalThis.__traps = 0;
    Object.defineProperty(Object.prototype, 'value', {
      configurable: true,
      get() { globalThis.__traps++; return 'polluted'; },
    });
    'installed';
  `);
  const result = value(await v.evalCode('40 + 2'));
  assert.deepEqual(result, {}, 'the completion wrapper is empty; nothing fabricated');
  // The getter never ran — read the counter through a descriptor path
  // (eval completions read as {} under this pollution, by the quirk above).
  const shim = getVmShim(v) as QuickJS;
  const e = shim._getExports();
  const globalHandle = shim.global; // cached singleton — do not dispose
  const key = shim.newString('__traps');
  let descPtr: number;
  try {
    descPtr = e.qjs_get_own_property_descriptor(globalHandle.ptr, key.ptr);
  } finally {
    key.dispose();
  }
  assert.notEqual(descPtr, 0);
  const desc = new JSValueHandle(shim, descPtr);
  try {
    const key2 = shim.newString('value');
    let vp: number;
    try {
      vp = e.qjs_get_prop_value(desc.ptr, key2.ptr);
    } finally {
      key2.dispose();
    }
    const val = new JSValueHandle(shim, vp);
    try {
      assert.equal(val.isNumber, true);
      assert.equal(val.toNumber(), 0, 'no guest getter ran');
    } finally {
      val.dispose();
    }
  } finally {
    desc.dispose();
  }
  // The VM stays fully usable (completions still degrade to {} — the
  // quirk persists until the pollution is removed).
  assert.deepEqual(value(await v.evalCode('1 + 1')), {});
});
