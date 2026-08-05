/**
 * Phase B tests: the doc's tool-result output caps — 256 lines or 10 KB
 * per tool result, whichever trips first; over-cap content remains
 * reachable through the $N refs the capped lines carry.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_LINES,
  applyOutputCaps,
} from '../src/index.js';

test('under the caps: every line is kept and nothing is truncated', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  const result = applyOutputCaps(lines);
  assert.deepEqual(result.lines, lines);
  assert.equal(result.truncated, false);
});

test('empty input: no lines, not truncated', () => {
  const result = applyOutputCaps([]);
  assert.deepEqual(result.lines, []);
  assert.equal(result.truncated, false);
});

test('the line cap: 256 lines fit exactly; the 257th trips it', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `l${i}`);
  const result = applyOutputCaps(lines);
  assert.equal(result.lines.length, OUTPUT_MAX_LINES);
  assert.deepEqual(result.lines, lines.slice(0, OUTPUT_MAX_LINES));
  assert.equal(result.truncated, true);
});

test('exactly 256 lines (tiny) are kept in full', () => {
  const lines = Array.from({ length: OUTPUT_MAX_LINES }, () => 'x');
  const result = applyOutputCaps(lines);
  assert.equal(result.lines.length, OUTPUT_MAX_LINES);
  assert.equal(result.truncated, false);
});

test('the byte cap trips before the line cap for long lines (10 KB decimal, incl. separators)', () => {
  // 100-byte lines: 99 lines = 9998 bytes (99×100 + 98 separators) fit;
  // the 100th would carry the total to 10099 > 10 000 — line-granular
  // truncation drops it.
  const lines = Array.from({ length: 100 }, () => 'x'.repeat(100));
  const result = applyOutputCaps(lines);
  assert.equal(result.lines.length, 99);
  assert.equal(result.truncated, true);
  // The kept lines' serialized byte count (with \n separators) fits.
  const serialized = result.lines.join('\n');
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= OUTPUT_MAX_BYTES);
});

test('whichever trips first: short lines hit the line cap, long lines hit the byte cap', () => {
  // 300 short lines: the LINE cap trips first.
  const short = applyOutputCaps(Array.from({ length: 300 }, () => 'a'));
  assert.equal(short.lines.length, OUTPUT_MAX_LINES);
  assert.equal(short.truncated, true);
  // 30 long lines: the BYTE cap trips first.
  const long = applyOutputCaps(Array.from({ length: 30 }, () => 'b'.repeat(2000)));
  assert.ok(long.lines.length < 30);
  assert.ok(long.lines.length < OUTPUT_MAX_LINES);
  assert.equal(long.truncated, true);
  const serialized = long.lines.join('\n');
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= OUTPUT_MAX_BYTES);
});

test('multi-byte characters count as their UTF-8 bytes, not code points', () => {
  // 4000 'é' characters = 8000 bytes; two of them (16000 bytes) trip the cap.
  const result = applyOutputCaps(['é'.repeat(4000), 'é'.repeat(4000)]);
  assert.equal(result.lines.length, 1);
  assert.equal(result.truncated, true);
});

test('embedded newlines inside a rendered line count as physical lines (review regression)', () => {
  // The previewer renders property names verbatim (FORMAT.md §5.18), so a
  // name carrying 300 line feeds reaches the tool result as 301 physical
  // lines inside ONE rendered line. The 256-line cap counts PHYSICAL
  // lines: 255 ordinary lines plus that entry would serialize as 556
  // lines, so the entry is dropped (line-granular) and truncation is
  // reported — previously the entry was retained whole with
  // `truncated: false`, silently shipping 301 serialized lines.
  const lines = Array.from({ length: 255 }, (_, i) => `l${i}`);
  lines.push('name-with-' + '\n'.repeat(300) + ': 1');
  const result = applyOutputCaps(lines);
  assert.equal(result.lines.length, 255);
  assert.equal(result.truncated, true);
  // The kept lines serialize to exactly 255 physical lines.
  assert.equal(result.lines.join('\n').split('\n').length, 255);
});

test('physical-line accounting is exact at the 256 boundary (embedded newlines included)', () => {
  // 254 ordinary lines + one line with a single embedded LF = 256
  // physical lines in 255 entries: fits exactly, not truncated.
  const fit = applyOutputCaps([...Array.from({ length: 254 }, () => 'x'), 'a\nb']);
  assert.equal(fit.lines.length, 255);
  assert.equal(fit.truncated, false);
  assert.equal(fit.lines.join('\n').split('\n').length, OUTPUT_MAX_LINES);
  // One more embedded LF in the same shape trips the line cap: 254 + 3 =
  // 257 physical lines, so the LF-carrying entry is dropped (line-granular)
  // and truncation is reported.
  const trip = applyOutputCaps([...Array.from({ length: 254 }, () => 'x'), 'a\nb\nc']);
  assert.equal(trip.lines.length, 254);
  assert.equal(trip.truncated, true);
  assert.equal(trip.lines.join('\n').split('\n').length, 254);
});

test('embedded-newline bytes count toward the 10 KB cap (UTF-8)', () => {
  // 9990 bytes of 'x' + 11 embedded LFs = 10001 bytes in ONE rendered
  // line: the byte cap trips (line-granular — the line is dropped).
  const trip = applyOutputCaps(['x'.repeat(9990) + '\n'.repeat(11)]);
  assert.equal(trip.lines.length, 0);
  assert.equal(trip.truncated, true);
  // 9990 bytes + 10 LFs = exactly 10000 bytes: fits.
  const fit = applyOutputCaps(['x'.repeat(9990) + '\n'.repeat(10)]);
  assert.equal(fit.lines.length, 1);
  assert.equal(fit.truncated, false);
});

test('the constants match the doc: 256 lines, 10 KB', () => {
  assert.equal(OUTPUT_MAX_LINES, 256);
  assert.equal(OUTPUT_MAX_BYTES, 10 * 1000);
});
