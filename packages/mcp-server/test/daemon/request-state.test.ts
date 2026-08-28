import assert from "node:assert/strict";
import { rmSync, statSync, writeFileSync } from "node:fs";
import test from "node:test";

import "../_harness.js";
import {
  loadOrCreateRequestStateKey,
  requestStateKeyPath,
} from "../../src/daemon/request-state.js";

test("daemon-family requestState key is stable, 256-bit, and stored 0600", () => {
  const fingerprint = `request-state-${process.pid}`;
  const path = requestStateKeyPath(fingerprint);
  rmSync(path, { force: true });
  const first = loadOrCreateRequestStateKey(fingerprint);
  const second = loadOrCreateRequestStateKey(fingerprint);
  assert.equal(first.byteLength, 32);
  assert.deepEqual(second, first);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("malformed requestState key storage fails closed instead of rotating silently", () => {
  const fingerprint = `request-state-malformed-${process.pid}`;
  const path = requestStateKeyPath(fingerprint);
  rmSync(path, { force: true });
  loadOrCreateRequestStateKey(fingerprint);
  writeFileSync(path, '{"version":1,"key":"short"}\n', { mode: 0o600 });
  assert.throws(() => loadOrCreateRequestStateKey(fingerprint), /Invalid daemon requestState key length/);
});
