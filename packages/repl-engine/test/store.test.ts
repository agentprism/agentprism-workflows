/**
 * Call-store tests: the append-only results-by-call-id ledger behind
 * exactly-once settlement. Pins the first-wins semantics (dispatch and
 * completion idempotence), the JSONL replay, and the crash-torn-tail
 * repair discipline (the harness's R55/R81 semantics: kill-at-any-point
 * is the normal lifecycle, so a torn tail must repair — never brick the
 * session — while newline-terminated corruption stays a hard error).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { InMemoryCallStore, JsonlCallStore, type CallKind, type CallOutcome, type CallRecord } from '../src/index.js';

function record(callId: string, kind: CallKind = 'agent'): CallRecord {
  return {
    callId,
    kind,
    detail: `task ${callId}`,
    optionsJson: null,
    modelSpec: kind === 'agent' ? 'pi/x' : null,
    backendId: null,
    foundingCallId: kind === 'queue' || kind === 'steer' || kind === 'cancel' ? 'c1' : null,
    admittedAtMs: 1,
    admissionSequence: Number(callId.slice(1)),
    dispatchedAtMs: 1,
    reissues: 0,
    completion: null,
    sessionId: null,
    queuedAtMs: null,
    handoffAtMs: null,
    cancelledAtMs: null,
  };
}

function outcome(value: unknown, outcomeKind: 'resolve' | 'reject' = 'resolve'): CallOutcome {
  return { outcome: outcomeKind, value, completedAtMs: 2 };
}

function tmpStore(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'repl-store-'));
  return { dir, path: join(dir, 'calls.jsonl') };
}

// ────────────────────────────────────────────────────────────────────────
// In-memory store
// ────────────────────────────────────────────────────────────────────────

test('in-memory store: first-wins dispatch and completion, unknown ids refused', () => {
  const store = new InMemoryCallStore();
  store.recordDispatched(record('c1'));
  // A re-dispatch of a known id keeps the original record.
  store.recordDispatched({ ...record('c1'), detail: 'second dispatch' });
  assert.equal(store.lookup('c1')!.detail, 'task c1');
  // First completion wins; the second reports false and changes nothing.
  assert.equal(store.recordCompleted('c1', outcome('first')), true);
  assert.equal(store.recordCompleted('c1', outcome('second')), false);
  assert.equal(store.lookup('c1')!.completion!.value, 'first');
  // Unknown ids are refused loudly (a dangling completion/re-issue would
  // corrupt the replay ledger).
  assert.throws(() => store.recordCompleted('cX', outcome('x')), /no record for call cX/);
  assert.throws(() => store.recordReissued('cX', 9), /no record for call cX/);
  // Re-issues bump the counter on the original record.
  store.recordReissued('c1', 9);
  assert.equal(store.lookup('c1')!.reissues, 1);
  // Dispatch order is preserved in all().
  store.recordDispatched(record('c2', 'checkpoint'));
  assert.deepEqual(store.all().map((r) => r.callId), ['c1', 'c2']);
});

test('in-memory store: queue admission, handoff, cancellation, and refusal settlement are durable first-wins fields', () => {
  const store = new InMemoryCallStore();
  store.recordDispatched({
    ...record('c2', 'queue'),
    detail: 'implement the fix',
    optionsJson: '{"promptMeta":{"trace":"yes"}}',
  });
  store.recordQueued('c2', 10);
  store.recordQueued('c2', 11);
  store.recordHandoff('c2', 20);
  store.recordHandoff('c2', 21);
  store.recordCancelled('c2', 30);
  store.recordCancelled('c2', 31);
  assert.deepEqual(store.lookup('c2'), {
    ...record('c2', 'queue'),
    detail: 'implement the fix',
    optionsJson: '{"promptMeta":{"trace":"yes"}}',
    queuedAtMs: 10,
    handoffAtMs: 20,
    cancelledAtMs: 30,
  });

  store.recordDispatched({ ...record('c3', 'queue'), detail: 'invalid admission' });
  assert.equal(store.recordCompleted('c3', outcome({
    message: 'queue options: unknown option "schema"',
    code: 'SCRIPT_VALIDATION_ERROR',
    recoverable: false,
  }, 'reject')), true);
  assert.equal(store.lookup('c3')!.queuedAtMs, null, 'a validation refusal never enters the FIFO');
  assert.equal(store.lookup('c3')!.completion!.outcome, 'reject', 'the refusal is nevertheless durable');
});

// ────────────────────────────────────────────────────────────────────────
// JSONL store: replay
// ────────────────────────────────────────────────────────────────────────

test('jsonl store: appends replay on reopen; first-wins holds across reopens', () => {
  const { path } = tmpStore();
  const store = JsonlCallStore.open(path);
  store.recordDispatched(record('c1'));
  store.recordDispatched(record('c2', 'checkpoint'));
  store.recordDispatched(record('c3', 'queue'));
  store.recordQueued('c3', 3);
  store.recordHandoff('c3', 4);
  store.recordCancelled('c3', 5);
  store.recordCompleted('c1', outcome('done'));
  store.close();

  const reopened = JsonlCallStore.open(path);
  assert.equal(reopened.lookup('c1')!.completion!.value, 'done');
  assert.equal(reopened.lookup('c2')!.kind, 'checkpoint');
  assert.equal(reopened.lookup('c2')!.completion, null);
  assert.equal(reopened.lookup('c3')!.kind, 'queue');
  assert.equal(reopened.lookup('c3')!.queuedAtMs, 3);
  assert.equal(reopened.lookup('c3')!.handoffAtMs, 4);
  assert.equal(reopened.lookup('c3')!.cancelledAtMs, 5);
  // A second completion after reopen is refused (first-wins, log unchanged).
  assert.equal(reopened.recordCompleted('c1', outcome('second')), false);
  assert.equal(reopened.recordCompleted('c2', outcome('answered')), true);
  reopened.close();

  const again = JsonlCallStore.open(path);
  assert.equal(again.lookup('c1')!.completion!.value, 'done');
  assert.equal(again.lookup('c2')!.completion!.value, 'answered');
  again.close();
  rmSync(join(path, '..'), { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────
// JSONL store: torn-tail repair
// ────────────────────────────────────────────────────────────────────────

test('jsonl store: an unterminated unparseable tail is repaired (fragment preserved in a sidecar), records intact', () => {
  const { dir, path } = tmpStore();
  const store = JsonlCallStore.open(path);
  store.recordDispatched(record('c1'));
  store.recordCompleted('c1', outcome('ok'));
  store.close();
  // Simulate a crash mid-append: a partial JSON line with no newline.
  writeFileSync(path, readFileSync(path).toString() + 'ZZZ-TORN-{"event":"compl');
  // The append-side heal must ALSO apply: opening truncates the torn tail.
  const reopened = JsonlCallStore.open(path);
  assert.equal(reopened.lookup('c1')!.completion!.value, 'ok');
  // A subsequent append lands cleanly on its own line.
  assert.equal(reopened.recordDispatched(record('c2')), undefined);
  reopened.close();
  const raw = readFileSync(path, 'utf8');
  assert.ok(raw.endsWith('\n'), 'the repaired log is newline-terminated');
  assert.ok(!raw.includes('ZZZ-TORN-'), 'the torn fragment is gone from the log');
  // The fragment was durably preserved before the truncation.
  const sidecars = readdirSync(dir).filter((f) => f.includes('.torn-'));
  assert.equal(sidecars.length, 1);
  assert.ok(readFileSync(join(dir, sidecars[0]), 'utf8').includes('ZZZ-TORN-'));
  rmSync(dir, { recursive: true, force: true });
});

test('jsonl store: an unterminated but complete tail is KEPT with its terminator restored', () => {
  const { path } = tmpStore();
  const store = JsonlCallStore.open(path);
  store.recordDispatched(record('c1'));
  store.close();
  // The crash landed between the record's bytes and its newline: the
  // record is complete and must survive (a completion whose result was
  // already paid for must not vaporize).
  const line = readFileSync(path, 'utf8').trim();
  writeFileSync(path, line); // drop the trailing newline
  const reopened = JsonlCallStore.open(path);
  assert.equal(reopened.lookup('c1')!.callId, 'c1');
  // The terminator is restored so the next append starts its own line.
  assert.equal(reopened.recordDispatched(record('c2')), undefined);
  reopened.close();
  const raw = readFileSync(path, 'utf8');
  const lines = raw.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.trim() !== ''));
  rmSync(join(path, '..'), { recursive: true, force: true });
});

test('jsonl store: newline-terminated corruption anywhere is a hard error (external damage, not a crash)', () => {
  const { path } = tmpStore();
  const store = JsonlCallStore.open(path);
  store.recordDispatched(record('c1'));
  store.close();
  // A line that HAS its newline was fully written — garbage there means
  // external damage, and skipping it would corrupt the replay ledger.
  writeFileSync(path, readFileSync(path, 'utf8') + 'not json at all\n');
  assert.throws(() => JsonlCallStore.open(path), /corrupt log line/);
  rmSync(join(path, '..'), { recursive: true, force: true });
});

test('jsonl store: a partial append is healed to the acknowledged prefix before the next write', () => {
  const { path } = tmpStore();
  const store = JsonlCallStore.open(path);
  store.recordDispatched(record('c1'));
  store.recordCompleted('c1', outcome('ok'));
  // Simulate a failed write's residue: bytes beyond the acknowledged
  // prefix with no newline (as if writeSync returned mid-line and the
  // caller retried).
  const size = statSync(path).size;
  writeFileSync(path, readFileSync(path, 'utf8') + '{"event":"completed","callId":"c2","outcome":');
  // The next append heals the residue first: the log stays parseable.
  store.recordDispatched(record('c3'));
  store.close();
  const reopened = JsonlCallStore.open(path);
  assert.equal(reopened.lookup('c1')!.completion!.value, 'ok');
  assert.equal(reopened.lookup('c2'), undefined, 'the partial record was rolled back');
  assert.equal(reopened.lookup('c3')!.callId, 'c3');
  assert.ok(size > 0, 'sanity: the file had content');
  reopened.close();
  rmSync(join(path, '..'), { recursive: true, force: true });
});

test('jsonl store: unknown-id completions refuse to append (the log never carries dangling completions)', () => {
  const { path } = tmpStore();
  const store = JsonlCallStore.open(path);
  store.recordDispatched(record('c1'));
  assert.throws(() => store.recordCompleted('cX', outcome('x')), /no record for call cX/);
  store.close();
  const raw = readFileSync(path, 'utf8');
  assert.ok(!raw.includes('cX'), 'nothing was appended');
  rmSync(join(path, '..'), { recursive: true, force: true });
});

test('jsonl store: a missing file opens empty and creates the log on first write', () => {
  const { path } = tmpStore();
  assert.ok(!existsSync(path));
  const store = JsonlCallStore.open(path);
  assert.equal(store.all().length, 0);
  store.recordDispatched(record('c1'));
  store.close();
  assert.ok(existsSync(path));
  rmSync(join(path, '..'), { recursive: true, force: true });
});
