/**
 * Eval-break channel tests (phase-F review rounds 2–4 — the out-of-band
 * interrupt delivery): the worker-thread relay's HTTP endpoint arms a
 * shared-memory flag that the probe consumes with the arm-after-start
 * rule. The rule is ordered by a SHARED MONOTONIC ARM-SEQUENCE COUNTER
 * (round 3: the wall-clock comparison was replaced — a break arriving
 * in the same millisecond as the execution's start was consumed as
 * stale and permanently lost; a sequence has no resolution window), so
 * a break armed after the execution began breaks it — down to the same
 * instant — and a stale break (armed while the workspace was idle) is
 * consumed-and-dropped on first observation and never breaks a later
 * execution. Slots grow on demand (no project-count ceiling) and are
 * released by `unregister` (round 3: the old fixed 64-slot array threw
 * on the 65th registered project and never released slots).
 *
 * Round 4 — registration is ACKNOWLEDGED and slot assignments are
 * GENERATION-FENCED: `register` resolves only once the worker applied
 * the key→slot mapping (a first interrupt can never 404 against an
 * unapplied mapping), and a stale arm for a RELEASED incarnation of a
 * slot (the worker still held the old key's mapping when its `/break`
 * landed) can never break the workspace that reuses the slot — the
 * arm carries the old generation, which the new key's consume drops.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createEvalBreakChannel, type EvalBreakChannel } from '../src/index.js';

async function armViaHttp(channel: EvalBreakChannel, key: string): Promise<number> {
  const response = await fetch(`${await channel.breakUrl()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  return response.status;
}

async function armOkViaHttp(channel: EvalBreakChannel, key: string): Promise<void> {
  const status = await armViaHttp(channel, key);
  assert.equal(status, 204, 'the relay arms registered keys');
}

test('the channel arms via its HTTP endpoint and the probe consumes with the arm-after-start rule', async () => {
  const channel = createEvalBreakChannel();
  try {
    await channel.register('ws-a');
    // Unknown keys are refused by the relay (404) and by the probe.
    assert.equal(await armViaHttp(channel, 'ws-nope'), 404);
    assert.equal(channel.consumeBreak('ws-nope', channel.executionStartMarker()), false);

    // A break armed BEFORE the execution began (a stale flag — the
    // workspace was idle when the interrupt was fired) is consumed-and-
    // dropped: the probe returns false and the flag is gone.
    await armOkViaHttp(channel, 'ws-a');
    const staleSince = channel.executionStartMarker(); // the execution began AFTER the arm
    assert.equal(channel.consumeBreak('ws-a', staleSince), false, 'stale break dropped');
    assert.equal(channel.consumeBreak('ws-a', staleSince), false, 'the stale flag was consumed — nothing lingers');

    // A break armed AFTER the execution began breaks it — exactly once
    // (the consume-on-observation semantics). The marker is read BEFORE
    // the arm: the arm's sequence strictly follows it, so the break is
    // delivered even when both fall within the same wall-clock
    // millisecond (phase-F review round 3: the old Date.now()
    // comparison required armedAt > executionStartMs and lost a same-ms
    // break as stale).
    const t0 = channel.executionStartMarker();
    await armOkViaHttp(channel, 'ws-a');
    assert.equal(channel.consumeBreak('ws-a', t0), true, 'the running execution breaks');
    assert.equal(channel.consumeBreak('ws-a', t0), false, 'consumed on first observation');

    // clearBreak drops an armed flag without consuming it.
    await armOkViaHttp(channel, 'ws-a');
    channel.clearBreak('ws-a');
    assert.equal(channel.consumeBreak('ws-a', channel.executionStartMarker()), false, 'cleared flags never fire');

    // A break armed AFTER a later execution began breaks THAT execution
    // (the per-execution marker, not a global one).
    const t2 = channel.executionStartMarker();
    await armOkViaHttp(channel, 'ws-a');
    assert.equal(channel.consumeBreak('ws-a', t2 - 1), true, 'armed after the execution start');
  } finally {
    await channel.dispose();
  }
});

test('the channel is per-key: arming one workspace never breaks another', async () => {
  const channel = createEvalBreakChannel();
  try {
    await channel.register('ws-a');
    await channel.register('ws-b');
    const t0 = channel.executionStartMarker();
    await armOkViaHttp(channel, 'ws-a');
    assert.equal(channel.consumeBreak('ws-a', t0), true, 'the armed workspace breaks');
    assert.equal(channel.consumeBreak('ws-b', t0), false, 'the sibling workspace never fires');
    // A stale arm for one key does not consume another key's later arm.
    const t1 = channel.executionStartMarker();
    await armOkViaHttp(channel, 'ws-b');
    assert.equal(channel.consumeBreak('ws-b', t1), true);
  } finally {
    await channel.dispose();
  }
});

test('re-registration is idempotent and the slot table survives it', async () => {
  const channel = createEvalBreakChannel();
  try {
    await channel.register('ws-a');
    await channel.register('ws-a');
    const t0 = channel.executionStartMarker();
    await armOkViaHttp(channel, 'ws-a');
    assert.equal(channel.consumeBreak('ws-a', t0), true, 'the re-registered key still arms');
  } finally {
    await channel.dispose();
  }
});

test('registration is ACKNOWLEDGED: after `await register` the relay never 404s for the key (round 4: the fire-and-forget registration let a first interrupt hit an unapplied mapping)', async () => {
  const channel = createEvalBreakChannel();
  try {
    // The ack gate: the promise resolves only once the worker APPLIED
    // the mapping — an immediately-following arm must succeed.
    const registration = channel.register('ws-ack');
    await registration;
    assert.equal(await armViaHttp(channel, 'ws-ack'), 204, 'the acked mapping arms immediately');
    // Idempotent re-registration resolves against the live mapping
    // (the ack is already settled — no second round trip needed).
    await channel.register('ws-ack');
    // A pending registration whose channel dies rejects instead of
    // hanging (awaiting brokers degrade to the deadline bound). The
    // outcome handler is attached BEFORE the dispose so the rejection
    // is never unhandled.
    const channel2 = createEvalBreakChannel();
    const dying = channel2.register('ws-doomed');
    const outcome = dying.then(
      () => 'resolved',
      (error: Error) => `rejected: ${error.message}`,
    );
    await channel2.dispose();
    assert.match(await outcome, /rejected: .*disposed/, 'the pending ack rejects when the channel dies');
  } finally {
    await channel.dispose();
  }
});

test('released slots are GENERATION-FENCED: a late arm for the released key can never break the workspace that reuses the slot (round 4)', async () => {
  const channel = createEvalBreakChannel();
  try {
    await channel.register('old');
    channel.unregister('old');
    // The re-registration is NOT awaited: the worker may still hold the
    // released 'old'→slot mapping when its `/break` arrives (the
    // register message for 'new' is in flight) — exactly the round-4
    // stale-arm window. Whichever interleaving wins, the new key must
    // never observe the break:
    //  - the arm lands before the worker applies 'new' → it writes the
    //    OLD generation into the reused slot → 'new's consume drops it;
    //  - the worker already applied 'new' → the arm 404s (no flag).
    const reRegistration = channel.register('new');
    const t0 = channel.executionStartMarker();
    const lateArm = await armViaHttp(channel, 'old');
    assert.ok([204, 404].includes(lateArm), `the late arm either lands (204) or 404s: ${lateArm}`);
    // Let the re-registration settle (the ack may still be in flight)
    // and consume repeatedly: any flag the late arm wrote is
    // generation-dropped, and nothing lingers for a later execution.
    await reRegistration;
    for (let i = 0; i < 5; i++) {
      assert.equal(channel.consumeBreak('new', t0), false, 'the reused slot never fires for the new key');
    }
    // The new key still arms and breaks normally under its own
    // generation once it is registered and acked.
    const t1 = channel.executionStartMarker();
    await armOkViaHttp(channel, 'new');
    assert.equal(channel.consumeBreak('new', t1), true, 'the re-registered key arms again');
  } finally {
    await channel.dispose();
  }
});

test('slots GROW beyond the initial capacity (no project-count ceiling) and unregister RELEASES them for reuse', async () => {
  const channel = createEvalBreakChannel();
  try {
    // Register more keys than the initial slot capacity: the shared
    // buffer grows on demand instead of refusing (phase-F review round
    // 3: the old fixed 64-slot channel threw on capacity exhaustion —
    // the roadmap defines per-project workspaces with no project-count
    // cap).
    const keys = Array.from({ length: 40 }, (_, i) => `ws-${String(i).padStart(2, '0')}`);
    for (const key of keys) await channel.register(key);
    const t0 = channel.executionStartMarker();
    for (const key of keys) {
      await armOkViaHttp(channel, key);
      assert.equal(channel.consumeBreak(key, t0), true, `${key} arms and breaks after growth`);
    }
    // An unregistered key is refused again...
    channel.unregister('ws-17');
    const t1 = channel.executionStartMarker();
    assert.equal(await armViaHttp(channel, 'ws-17'), 404, 'the unregistered key is unknown to the relay');
    assert.equal(channel.consumeBreak('ws-17', t1), false, 'the unregistered key never fires');
    // ...and its slot is REUSED by the next registration (the released
    // slot's stale flag was cleared with it — the reused slot never
    // fires for the new key without a fresh arm).
    await channel.register('ws-17');
    const t2 = channel.executionStartMarker();
    assert.equal(channel.consumeBreak('ws-17', t2), false, 'the reused slot carries no stale flag');
    await armOkViaHttp(channel, 'ws-17');
    assert.equal(channel.consumeBreak('ws-17', t2), true, 'the re-registered key arms again');
    // Idempotent unregister / unregister of an unknown key are no-ops.
    channel.unregister('ws-17');
    channel.unregister('ws-17');
    channel.unregister('never-registered');
    const t3 = channel.executionStartMarker();
    await armOkViaHttp(channel, 'ws-00');
    assert.equal(channel.consumeBreak('ws-00', t3), true, 'the other keys keep working across the unregisters');
  } finally {
    await channel.dispose();
  }
});
