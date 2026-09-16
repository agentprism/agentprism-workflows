// The per-agent FIFO (src/agent/queue.ts) in isolation: strict serialization, queued-abort
// removal, and drain semantics. No fake agent — the queue is pure.
import test from "node:test";
import assert from "node:assert/strict";
import { SerialQueue } from "../../src/agent/queue.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-settled promise callback run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("serializes ops in order and never overlaps", async () => {
  const queue = new SerialQueue();
  const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
  const started: number[] = [];
  const results = gates.map((gate, index) =>
    queue.run(async () => {
      started.push(index);
      return gate.promise;
    }),
  );

  await tick();
  assert.deepEqual(started, [0], "only the first op has started");
  assert.equal(queue.running, true);
  assert.equal(queue.depth, 3);

  gates[2]!.resolve("early"); // settling a LATER gate must not let its op start out of order
  await tick();
  assert.deepEqual(started, [0], "the second op waits for the first to settle");

  gates[0]!.resolve("first");
  await tick();
  assert.deepEqual(started, [0, 1], "the second starts strictly after the first settled");
  await tick();
  assert.deepEqual(started, [0, 1], "the third waits for the second even though its own gate is open");

  gates[1]!.resolve("second");
  await tick();
  assert.deepEqual(started, [0, 1, 2], "the third starts once the second settled");
  assert.deepEqual(await Promise.all(results), ["first", "second", "early"]);
  await queue.whenIdle();
  assert.equal(queue.running, false);
  assert.equal(queue.depth, 0);
});

test("a queued entry aborted before start rejects with signal.reason and never runs", async () => {
  const queue = new SerialQueue();
  const gate = deferred<void>();
  const running = queue.run(() => gate.promise);

  const controller = new AbortController();
  const reason = new Error("dropped while queued");
  let called = 0;
  const queued = queue.run(async () => {
    called += 1;
  }, controller.signal);
  assert.equal(queue.depth, 2);

  controller.abort(reason);
  await assert.rejects(queued, (error: unknown) => error === reason);
  assert.equal(queue.depth, 1, "the aborted entry was removed from the queue");

  gate.resolve();
  await running;
  await queue.whenIdle();
  assert.equal(called, 0, "the op spy never ran");

  // An already-aborted signal rejects synchronously-observably and never enqueues either.
  const preAborted = new AbortController();
  const preReason = new Error("already aborted");
  preAborted.abort(preReason);
  await assert.rejects(
    queue.run(async () => {
      called += 1;
    }, preAborted.signal),
    (error: unknown) => error === preReason,
  );
  assert.equal(called, 0);
  assert.equal(queue.depth, 0);
});

test("drain rejects queued entries but leaves the running op alone", async () => {
  const queue = new SerialQueue();
  const gate = deferred<string>();
  const running = queue.run(() => gate.promise);
  const controller = new AbortController();
  let ran = 0;
  const queuedA = queue.run(async () => {
    ran += 1;
  });
  const queuedB = queue.run(async () => {
    ran += 1;
  }, controller.signal);
  await tick();
  assert.equal(queue.depth, 3);

  const reason = new Error("drained");
  queue.drain(reason);
  await assert.rejects(queuedA, (error: unknown) => error === reason);
  await assert.rejects(queuedB, (error: unknown) => error === reason);
  assert.equal(queue.running, true, "the running op is untouched");
  assert.equal(queue.depth, 1);

  gate.resolve("still resolves");
  assert.equal(await running, "still resolves");
  await queue.whenIdle();
  assert.equal(ran, 0);
  assert.equal(queue.running, false);

  // A drained entry's abort listener was dropped: aborting afterwards is a no-op.
  controller.abort(new Error("late"));
  const after = await queue.run(async () => "after drain");
  assert.equal(after, "after drain");
});
