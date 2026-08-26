/**
 * The generated-documentation GATE for the per-backend steering
 * mechanism table (the roadmap doc's spec-owed decision: "the table is
 * documentation generated from the capability probes" — implemented as
 * a generated artifact, never deferred to a later phase). The gate
 * regenerates the document from the LIVE capability probes
 * (`ACP_EXTENSION_SUPPORT_MATRIX` in `@automatalabs/acp-agents`) and
 * compares it byte-for-byte with the checked-in
 * `docs/steering-mechanism-table.md`: a capability-matrix change that
 * is not reflected in the documentation fails the suite.
 *
 * Regenerate with
 * `pnpm --filter @automatalabs/repl-engine generate:steering-table`.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  generateSteeringMechanismTable,
  steeringMechanismRows,
} from '../src/steering-table.js';

test('the per-backend steering mechanism table is GENERATED from the capability probes and the checked-in document matches (the doc\'s generated table is implemented and gated, never deferred)', async () => {
  const generated = generateSteeringMechanismTable();
  const checkedIn = await readFile(
    fileURLToPath(new URL('../docs/steering-mechanism-table.md', import.meta.url)),
    'utf8',
  );
  assert.equal(
    generated,
    checkedIn,
    'docs/steering-mechanism-table.md drifted from the capability probes — run ' +
      '`pnpm --filter @automatalabs/repl-engine generate:steering-table` and commit the regenerated document',
  );
});

test('the generated table reflects the live probe dispositions (every built-in backend row is derived, and the mechanism follows the disposition)', () => {
  const rows = steeringMechanismRows();
  // The built-in backends' `_session/steering` dispositions, straight
  // from the probed matrix (protocol-coverage.ts): claude, codex and pi
  // advertise the extension; opencode is typed-unsupported. This table
  // is documentation only — runtime routing reads raw initialize metadata.
  const byBackend = new Map(rows.map((row) => [row.backend, row]));
  assert.deepEqual([...byBackend.keys()].sort(), ['claude', 'codex', 'opencode', 'pi']);
  assert.equal(byBackend.get('claude')!.advertised, true);
  assert.equal(byBackend.get('claude')!.mechanism, 'strict active-turn injection');
  assert.equal(byBackend.get('claude')!.distProbe, 'claude');
  assert.equal(byBackend.get('codex')!.advertised, true);
  assert.equal(byBackend.get('codex')!.mechanism, 'strict active-turn injection');
  assert.equal(byBackend.get('codex')!.distProbe, 'codex');
  assert.equal(byBackend.get('pi')!.advertised, true);
  assert.equal(byBackend.get('pi')!.mechanism, 'strict active-turn injection');
  assert.equal(byBackend.get('opencode')!.advertised, false);
  assert.equal(byBackend.get('opencode')!.disposition, 'not-advertised');
  assert.equal(byBackend.get('opencode')!.mechanism, 'unsupported');
  const doc = generateSteeringMechanismTable();
  assert.ok(doc.includes('custom backend'), 'the raw-metadata custom row is documented');
  assert.ok(doc.includes('handle.queue(prompt)'), 'future turns are documented as explicit queue work');
  assert.ok(doc.includes('no steering wire request'), 'unadvertised steering never falls back to a prompt');
  assert.ok(
    !doc.includes('queued-for-next-turn delivery'),
    'the removed queued-steering fallback is absent',
  );
  // EXACTLY ONE terminal newline (phase-E review rejection: the
  // generator emitted two, so `git diff --check` failed with "new blank
  // line at EOF" on the checked-in artifact).
  assert.ok(doc.endsWith('\n'), 'the document ends with a newline');
  assert.ok(!doc.endsWith('\n\n'), 'exactly one terminal newline — no trailing blank line');
});
