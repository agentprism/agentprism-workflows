// The run-monitor event poll's timing/stop policy (poll-backoff.ts): idle polls back off
// 2s → 4s → 8s → cap and reset the moment new events arrive, error retries back off to the cap,
// and the loop gives up only after a bounded run of consecutive faults so a dead run is not polled
// forever. These are the ITEM 2a (adaptive no-op backoff) and ITEM 2c (bounded retry) rules,
// factored out of the React effect so they can be checked without a DOM or fake timers.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_BACKOFF_MS,
  MAX_POLL_FAILURES,
  nextErrorBackoffMs,
  nextIdleDelayMs,
  POLL_MS,
  shouldGiveUp,
} from "../ui/src/poll-backoff.js";

test("idle polls double 2s → 4s → 8s → cap and reset when new events arrive", () => {
  assert.equal(POLL_MS, 2000);
  assert.equal(MAX_BACKOFF_MS, 15_000);

  // A run that keeps returning zero new events doubles the next delay toward the cap.
  let delay = POLL_MS;
  const progression: number[] = [];
  for (let poll = 0; poll < 5; poll += 1) {
    delay = nextIdleDelayMs(delay, false);
    progression.push(delay);
  }
  assert.deepEqual(progression, [4000, 8000, 15_000, 15_000, 15_000]);

  // Any poll that brings new events resets to the base cadence, whatever the current delay.
  assert.equal(nextIdleDelayMs(15_000, true), POLL_MS);
  assert.equal(nextIdleDelayMs(POLL_MS, true), POLL_MS);
});

test("error retries double toward the cap", () => {
  assert.equal(nextErrorBackoffMs(POLL_MS), 4000);
  assert.equal(nextErrorBackoffMs(4000), 8000);
  assert.equal(nextErrorBackoffMs(8000), MAX_BACKOFF_MS);
  assert.equal(nextErrorBackoffMs(MAX_BACKOFF_MS), MAX_BACKOFF_MS);
});

test("the poll loop keeps retrying until the bounded fault count is reached, then gives up", () => {
  for (let failures = 1; failures < MAX_POLL_FAILURES; failures += 1) {
    assert.equal(shouldGiveUp(failures), false, `must keep retrying at ${failures} consecutive faults`);
  }
  assert.equal(shouldGiveUp(MAX_POLL_FAILURES), true);
  assert.equal(shouldGiveUp(MAX_POLL_FAILURES + 1), true);
});
