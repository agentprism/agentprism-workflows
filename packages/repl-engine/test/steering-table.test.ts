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
  // advertise the extension (live injection); opencode is
  // typed-unsupported (queued-for-next-turn delivery).
  const byBackend = new Map(rows.map((row) => [row.backend, row]));
  assert.deepEqual([...byBackend.keys()].sort(), ['claude', 'codex', 'opencode', 'pi']);
  assert.equal(byBackend.get('claude')!.advertised, true);
  assert.equal(byBackend.get('claude')!.mechanism, 'live injection');
  assert.equal(byBackend.get('claude')!.distProbe, 'claude');
  assert.equal(byBackend.get('codex')!.advertised, true);
  assert.equal(byBackend.get('codex')!.mechanism, 'live injection');
  assert.equal(byBackend.get('codex')!.distProbe, 'codex');
  assert.equal(byBackend.get('pi')!.advertised, true);
  assert.equal(byBackend.get('pi')!.mechanism, 'live injection');
  assert.equal(byBackend.get('opencode')!.advertised, false);
  assert.equal(byBackend.get('opencode')!.disposition, 'typed-unsupported');
  assert.equal(byBackend.get('opencode')!.mechanism, 'queued delivery');
  // The document carries the custom-backend capability-gated row and the
  // per-case mechanism table.
  const doc = generateSteeringMechanismTable();
  assert.ok(doc.includes('custom backend'), 'the capability-gated custom row is documented');
  assert.ok(doc.includes('queued'), 'the queued-for-next-turn fallback is documented');
  // The CORRECTED cancel-during-opening case (phase-E review rejection:
  // the table used to claim cancel() during opening is a no-op that
  // returns `failed` while the call continues — broker.cancelCall now
  // cancels the opening call, fences it, settles it durably as
  // AGENT_CANCELLED, and returns `cancelled`; the generated table must
  // pin the implemented behavior, never the stale prose).
  assert.ok(
    doc.includes('the opening call is fenced and settled durably as cancelled'),
    'the table documents the fenced + durable opening-cancel',
  );
  assert.ok(
    doc.includes('`cancelled` (the cancelled call rejects with the recoverable `AGENT_CANCELLED`)'),
    'the opening-cancel outcome is the honest `cancelled`',
  );
  assert.ok(
    !doc.includes('no-op — nothing was running to cancel'),
    'the stale no-op claim is gone from the generated document',
  );
  // EXACTLY ONE terminal newline (phase-E review rejection: the
  // generator emitted two, so `git diff --check` failed with "new blank
  // line at EOF" on the checked-in artifact).
  assert.ok(doc.endsWith('\n'), 'the document ends with a newline');
  assert.ok(!doc.endsWith('\n\n'), 'exactly one terminal newline — no trailing blank line');
});
