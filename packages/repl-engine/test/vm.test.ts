/**
 * Engine-level tests: VM instantiation (shipped wasm), eval semantics,
 * the job drain, memory limits, and per-eval interrupts. Deterministic
 * and credential-free; every case runs against the `quickjs-wasi` npm
 * package's shipped `quickjs.wasm` binary (the doc's mapping table: the
 * package used as-is, including its binary).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ReplVm, loadShippedWasm } from '../src/index.js';

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
