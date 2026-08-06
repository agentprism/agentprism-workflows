/**
 * Eval-break channel tests (phase-F review round 2 — the out-of-band
 * interrupt delivery): the worker-thread relay's HTTP endpoint arms a
 * shared-memory flag that the probe consumes with the arm-after-start
 * rule — a break armed after the execution began breaks it; a stale
 * break (armed while the workspace was idle) is consumed-and-dropped on
 * first observation and never breaks a later execution.
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
    assert.equal(channel.consumeBreak('ws-nope', Date.now()), false);

    const t0 = Date.now();
    // A break armed BEFORE the execution began (a stale flag — the
    // workspace was idle when the interrupt was fired) is consumed-and-
    // dropped: the probe returns false and the flag is gone.
    await armViaHttp(channel, 'ws-a');
    const staleSince = Date.now(); // the execution began AFTER the arm
    assert.equal(channel.consumeBreak('ws-a', staleSince), false, 'stale break dropped');
    assert.equal(channel.consumeBreak('ws-a', staleSince), false, 'the stale flag was consumed — nothing lingers');

    // A break armed AFTER the execution began breaks it — exactly once
    // (the consume-on-observation semantics).
    const t1 = Date.now();
    await armViaHttp(channel, 'ws-a');
    assert.equal(channel.consumeBreak('ws-a', t1), true, 'the running execution breaks');
    assert.equal(channel.consumeBreak('ws-a', t1), false, 'consumed on first observation');

    // clearBreak drops an armed flag without consuming it.
    await armViaHttp(channel, 'ws-a');
    channel.clearBreak('ws-a');
    assert.equal(channel.consumeBreak('ws-a', Date.now()), false, 'cleared flags never fire');

    // A break armed AFTER a later execution began breaks THAT execution
    // (the per-execution clock, not a global one).
    const t2 = Date.now();
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
    const t0 = Date.now();
    await armViaHttp(channel, 'ws-a');
    assert.equal(channel.consumeBreak('ws-a', t0), true, 'the armed workspace breaks');
    assert.equal(channel.consumeBreak('ws-b', t0), false, 'the sibling workspace never fires');
    // A stale arm for one key does not consume another key's later arm.
    const t1 = Date.now();
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
    const t0 = Date.now();
    await armViaHttp(channel, 'ws-a');
    assert.equal(channel.consumeBreak('ws-a', t0), true, 'the re-registered key still arms');
  } finally {
    await channel.dispose();
  }
});
