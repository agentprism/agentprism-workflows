/**
 * Phase B tests: the doc's tool-result output caps — 4000 lines or 50 KB
 * per tool result, whichever trips first; over-cap content remains
 * reachable through the $N refs the capped lines carry. Boundaries are
 * expressed against OUTPUT_MAX_LINES / OUTPUT_MAX_BYTES so the suite tracks
 * the constants rather than pinning stale magic numbers.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_LINES,
  applyOutputCaps,
  capFinalText,
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

test('the line cap: OUTPUT_MAX_LINES tiny lines fit exactly; the next trips it', () => {
  // Single-byte lines so the LINE cap trips well before the byte cap.
  const lines = Array.from({ length: OUTPUT_MAX_LINES + 50 }, () => 'x');
  const result = applyOutputCaps(lines);
  assert.equal(result.lines.length, OUTPUT_MAX_LINES);
  assert.deepEqual(result.lines, lines.slice(0, OUTPUT_MAX_LINES));
  assert.equal(result.truncated, true);
});

test('exactly OUTPUT_MAX_LINES tiny lines are kept in full', () => {
  const lines = Array.from({ length: OUTPUT_MAX_LINES }, () => 'x');
  const result = applyOutputCaps(lines);
  assert.equal(result.lines.length, OUTPUT_MAX_LINES);
  assert.equal(result.truncated, false);
});

test('the byte cap trips before the line cap for long lines (decimal KB, incl. separators)', () => {
  // 1000-byte lines: far fewer than OUTPUT_MAX_LINES of them exhaust the
  // byte budget, so the BYTE cap is what truncates — line-granular.
  const perLine = 1000;
  const fits = Math.floor((OUTPUT_MAX_BYTES + 1) / (perLine + 1)); // lines that fit incl. separators
  const lines = Array.from({ length: fits + 20 }, () => 'x'.repeat(perLine));
  const result = applyOutputCaps(lines);
  assert.ok(result.lines.length < lines.length, 'the byte cap dropped the tail');
  assert.ok(result.lines.length < OUTPUT_MAX_LINES, 'the byte cap, not the line cap, bound the result');
  assert.equal(result.truncated, true);
  // The kept lines' serialized byte count (with \n separators) fits.
  const serialized = result.lines.join('\n');
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= OUTPUT_MAX_BYTES);
});

test('whichever trips first: short lines hit the line cap, long lines hit the byte cap', () => {
  // Many short lines: the LINE cap trips first.
  const short = applyOutputCaps(Array.from({ length: OUTPUT_MAX_LINES + 100 }, () => 'a'));
  assert.equal(short.lines.length, OUTPUT_MAX_LINES);
  assert.equal(short.truncated, true);
  // A handful of long lines: the BYTE cap trips first, well under the line cap.
  const longLineCount = Math.ceil(OUTPUT_MAX_BYTES / 2000) + 5;
  const long = applyOutputCaps(Array.from({ length: longLineCount }, () => 'b'.repeat(2000)));
  assert.ok(long.lines.length < longLineCount);
  assert.ok(long.lines.length < OUTPUT_MAX_LINES);
  assert.equal(long.truncated, true);
  const serialized = long.lines.join('\n');
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= OUTPUT_MAX_BYTES);
});

test('multi-byte characters count as their UTF-8 bytes, not code points', () => {
  // 'é' is 2 UTF-8 bytes: two lines just over half the byte budget each
  // sum past the cap, so only the first is kept.
  const perLineChars = Math.floor(OUTPUT_MAX_BYTES / 2 / 2) + 500; // ×2 bytes/char, over half the budget
  const result = applyOutputCaps(['é'.repeat(perLineChars), 'é'.repeat(perLineChars)]);
  assert.equal(result.lines.length, 1);
  assert.equal(result.truncated, true);
});

test('embedded newlines inside a rendered line count as physical lines (review regression)', () => {
  // The previewer renders property names verbatim (FORMAT.md §5.18), so a
  // name carrying line feeds reaches the tool result as many physical lines
  // inside ONE rendered line. The line cap counts PHYSICAL lines, so an
  // entry whose embedded newlines push the total past the cap is dropped
  // (line-granular) and truncation is reported — previously the entry was
  // retained whole with `truncated: false`.
  const ordinary = OUTPUT_MAX_LINES - 1;
  const lines = Array.from({ length: ordinary }, (_, i) => `l${i}`);
  lines.push('name-with-' + '\n'.repeat(300) + ': 1'); // 301 physical lines
  const result = applyOutputCaps(lines);
  assert.equal(result.lines.length, ordinary);
  assert.equal(result.truncated, true);
  // The kept lines serialize to exactly `ordinary` physical lines.
  assert.equal(result.lines.join('\n').split('\n').length, ordinary);
});

test('physical-line accounting is exact at the OUTPUT_MAX_LINES boundary (embedded newlines included)', () => {
  // (OUTPUT_MAX_LINES - 2) ordinary lines + one line with a single embedded
  // LF = OUTPUT_MAX_LINES physical lines in (OUTPUT_MAX_LINES - 1) entries:
  // fits exactly, not truncated.
  const base = Array.from({ length: OUTPUT_MAX_LINES - 2 }, () => 'x');
  const fit = applyOutputCaps([...base, 'a\nb']);
  assert.equal(fit.lines.length, OUTPUT_MAX_LINES - 1);
  assert.equal(fit.truncated, false);
  assert.equal(fit.lines.join('\n').split('\n').length, OUTPUT_MAX_LINES);
  // One more embedded LF in the same shape trips the line cap:
  // (OUTPUT_MAX_LINES - 2) + 3 = OUTPUT_MAX_LINES + 1 physical lines, so the
  // LF-carrying entry is dropped (line-granular) and truncation is reported.
  const trip = applyOutputCaps([...base, 'a\nb\nc']);
  assert.equal(trip.lines.length, OUTPUT_MAX_LINES - 2);
  assert.equal(trip.truncated, true);
  assert.equal(trip.lines.join('\n').split('\n').length, OUTPUT_MAX_LINES - 2);
});

test('embedded-newline bytes count toward the byte cap (UTF-8)', () => {
  // (OUTPUT_MAX_BYTES - 10) bytes of 'x' + 11 embedded LFs = OUTPUT_MAX_BYTES
  // + 1 bytes in ONE rendered line: the byte cap trips (line-granular).
  const trip = applyOutputCaps(['x'.repeat(OUTPUT_MAX_BYTES - 10) + '\n'.repeat(11)]);
  assert.equal(trip.lines.length, 0);
  assert.equal(trip.truncated, true);
  // (OUTPUT_MAX_BYTES - 10) bytes + 10 LFs = exactly OUTPUT_MAX_BYTES: fits.
  const fit = applyOutputCaps(['x'.repeat(OUTPUT_MAX_BYTES - 10) + '\n'.repeat(10)]);
  assert.equal(fit.lines.length, 1);
  assert.equal(fit.truncated, false);
});

test('the constants match the doc: 4000 lines, 50 KB', () => {
  assert.equal(OUTPUT_MAX_LINES, 4000);
  assert.equal(OUTPUT_MAX_BYTES, 50 * 1000);
});

test('capFinalText: under the caps the text returns unchanged, no marker', () => {
  const text = ['a', 'b', 'c'].join('\n');
  assert.equal(capFinalText(text, '(truncated)'), text);
});

test('capFinalText: an over-cap text is capped with the marker ALWAYS shipping, and the capped result never exceeds the caps (the tool result wire guarantee)', () => {
  const marker = '(tool result truncated — cap: 4000 lines / 50000 bytes)';
  // Short lines so the LINE cap (not the byte cap) is what trips.
  const lines = Array.from({ length: OUTPUT_MAX_LINES + 200 }, (_, i) => `line ${i}`);
  const capped = capFinalText(lines.join('\n'), marker);
  const cappedLines = capped.split('\n');
  // The marker's own budget (1 line + its bytes) is reserved inside the
  // caps, so the marker ships and the total stays at the cap.
  assert.equal(cappedLines.length, OUTPUT_MAX_LINES, 'marker + (OUTPUT_MAX_LINES - 1) content lines');
  assert.equal(cappedLines[cappedLines.length - 1], marker, 'the marker is the last line');
  assert.equal(cappedLines[0], 'line 0', 'the head is kept');
  assert.ok(!capped.includes(`line ${OUTPUT_MAX_LINES}`), 'the tail beyond the cap is dropped');
  assert.ok(Buffer.byteLength(capped, 'utf8') <= OUTPUT_MAX_BYTES, 'the byte cap holds');
});

test('capFinalText: the byte cap reserves the marker\'s bytes — the marker ships even when content fills the byte budget', () => {
  const marker = '(truncated)'; // 11 bytes + 1 separator
  // 1000-byte lines, enough to exceed the byte budget.
  const lineCount = Math.ceil(OUTPUT_MAX_BYTES / 1000) + 10;
  const lines = Array.from({ length: lineCount }, () => 'x'.repeat(1000));
  const capped = capFinalText(lines.join('\n'), marker);
  assert.ok(capped.endsWith(marker), `the marker ships: ${capped.slice(-40)}`);
  assert.ok(Buffer.byteLength(capped, 'utf8') <= OUTPUT_MAX_BYTES);
  // The content kept is bounded by the marker's reserved budget.
  assert.ok(capped.split('\n').length <= OUTPUT_MAX_LINES);
});

test('capFinalText: a metadata-heavy text (many sections) is capped as ONE result — the wire guarantee the tool layer relies on', () => {
  const marker = '(truncated)'; // 11 bytes
  // Simulates the assembled tool result: console lines + result line +
  // one pending line + many checkpoint lines (metadata sections were the
  // phase-E review rejection — they used to be appended UNcapped).
  const sections: string[] = [];
  sections.push('result: 42');
  sections.push('pending: c1, c2, c3');
  // Short tokens so the LINE cap is what trips (many sections stay under the
  // byte budget) — the point is that capFinalText caps the assembled result
  // as ONE result with the marker, whichever cap trips.
  for (let i = 0; i < OUTPUT_MAX_LINES + 100; i++) sections.push(`c${i}`);
  sections.push('completed: c1, c2');
  const capped = capFinalText(sections.join('\n'), marker);
  const cappedLines = capped.split('\n');
  assert.equal(cappedLines.length, OUTPUT_MAX_LINES);
  assert.equal(cappedLines[cappedLines.length - 1], marker);
  assert.equal(cappedLines[0], 'result: 42', 'the head sections are kept in order');
  assert.equal(cappedLines[1], 'pending: c1, c2, c3');
  assert.ok(!capped.includes('completed:'), 'the tail section is dropped');
});
