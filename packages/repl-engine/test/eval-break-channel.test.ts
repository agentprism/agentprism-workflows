/**
 * Eval-break channel tests (phase-F review rounds 2–3 — the out-of-band
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
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createEvalBreakChannel, type EvalBreakChannel } from '../src/index.js';

async function armViaHttp(channel: EvalBreakChannel, key: string): Promise<void> {
  const response = await fetch(`${await channel.breakUrl()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  assert.equal(response.status, 204, 'the relay arms registered keys');
}

test('the channel arms via its HTTP endpoint and the probe consumes with the arm-after-start rule', async () => {
  const channel = createEvalBreakChannel();
  try {
    channel.register('ws-a');
    // Unknown keys are refused by the relay (404) and by the probe.
    const unknown = await fetch(`${await channel.breakUrl()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'ws-nope' }),
    });
    assert.equal(unknown.status, 404);
    assert.equal(channel.consumeBreak('ws-nope', channel.executionStartMarker()), false);

    // A break armed BEFORE the execution began (a stale flag — the
    // workspace was idle when the interrupt was fired) is consumed-and-
    // dropped: the probe returns false and the flag is gone.
    await armViaHttp(channel, 'ws-a');
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
    await armViaHttp(channel, 'ws-a');
    assert.equal(channel.consumeBreak('ws-a', t0), true, 'the running execution breaks');
    assert.equal(channel.consumeBreak('ws-a', t0), false, 'consumed on first observation');

    // clearBreak drops an armed flag without consuming it.
    await armViaHttp(channel, 'ws-a');
    channel.clearBreak('ws-a');
    assert.equal(channel.consumeBreak('ws-a', channel.executionStartMarker()), false, 'cleared flags never fire');

    // A break armed AFTER a later execution began breaks THAT execution
    // (the per-execution marker, not a global one).
    const t2 = channel.executionStartMarker();
    await armViaHttp(channel, 'ws-a');
    assert.equal(channel.consumeBreak('ws-a', t2 - 1), true, 'armed after the execution start');
  } finally {
    await channel.dispose();
  }
});

test('the channel is per-key: arming one workspace never breaks another', async () => {
  const channel = createEvalBreakChannel();
  try {
    channel.register('ws-a');
    channel.register('ws-b');
    const t0 = channel.executionStartMarker();
    await armViaHttp(channel, 'ws-a');
    assert.equal(channel.consumeBreak('ws-a', t0), true, 'the armed workspace breaks');
    assert.equal(channel.consumeBreak('ws-b', t0), false, 'the sibling workspace never fires');
    // A stale arm for one key does not consume another key's later arm.
    const t1 = channel.executionStartMarker();
    await armViaHttp(channel, 'ws-b');
    assert.equal(channel.consumeBreak('ws-b', t1), true);
  } finally {
    await channel.dispose();
  }
});

test('re-registration is idempotent and the slot table survives it', async () => {
  const channel = createEvalBreakChannel();
  try {
    channel.register('ws-a');
    channel.register('ws-a');
    const t0 = channel.executionStartMarker();
    await armViaHttp(channel, 'ws-a');
    assert.equal(channel.consumeBreak('ws-a', t0), true, 'the re-registered key still arms');
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
    for (const key of keys) channel.register(key);
    const t0 = channel.executionStartMarker();
    for (const key of keys) {
      await armViaHttp(channel, key);
      assert.equal(channel.consumeBreak(key, t0), true, `${key} arms and breaks after growth`);
    }
    // An unregistered key is refused again...
    channel.unregister('ws-17');
    const t1 = channel.executionStartMarker();
    const after = await fetch(`${await channel.breakUrl()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'ws-17' }),
    });
    assert.equal(after.status, 404, 'the unregistered key is unknown to the relay');
    assert.equal(channel.consumeBreak('ws-17', t1), false, 'the unregistered key never fires');
    // ...and its slot is REUSED by the next registration (the released
    // slot's stale flag was cleared with it — the reused slot never
    // fires for the new key without a fresh arm).
    channel.register('ws-17');
    const t2 = channel.executionStartMarker();
    assert.equal(channel.consumeBreak('ws-17', t2), false, 'the reused slot carries no stale flag');
    await armViaHttp(channel, 'ws-17');
    assert.equal(channel.consumeBreak('ws-17', t2), true, 'the re-registered key arms again');
    // Idempotent unregister / unregister of an unknown key are no-ops.
    channel.unregister('ws-17');
    channel.unregister('ws-17');
    channel.unregister('never-registered');
    const t3 = channel.executionStartMarker();
    await armViaHttp(channel, 'ws-00');
    assert.equal(channel.consumeBreak('ws-00', t3), true, 'the other keys keep working across the unregisters');
  } finally {
    await channel.dispose();
  }
});
