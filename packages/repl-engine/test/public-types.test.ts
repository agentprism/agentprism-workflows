/**
 * Published-type-graph check: the `dist` declarations must be usable by a
 * consumer with the repository's non-DOM lib and `skipLibCheck: false`,
 * with no ambient `@types` and no unpublished source declarations.
 *
 * Regression (review): the public options referenced `BufferSource` /
 * `WebAssembly.Module`, declared only in `src/wasm-ambient.d.ts` — a
 * source-only ambient that TypeScript does not emit, while the published
 * package ships `dist` only. A consumer check failed with seven
 * missing-type errors across `dist/vm.d.ts` and `dist/workspace.d.ts`.
 *
 * The fixture (`test/fixtures/types-consumer/`) imports the built
 * `dist/index.js` declarations and exercises the whole public surface;
 * this test compiles it and fails if any declaration is missing.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const consumerDir = join(here, 'fixtures', 'types-consumer');

test('published type graph is self-contained for a non-DOM consumer (skipLibCheck: false)', () => {
  // The consumer imports the published declarations (dist), so build the
  // package first — with --force so the check never depends on incremental
  // build state being correct (a stale dist that looks newer than src would
  // otherwise be checked as-is).
  execFileSync(process.execPath, [tsc, '-b', '--force', join(packageRoot, 'tsconfig.json')], {
    stdio: 'pipe',
  });
  assert.ok(
    existsSync(join(packageRoot, 'dist', 'index.d.ts')),
    'build must produce dist/index.d.ts',
  );
  // The fixture's tsconfig: ES2022 lib (no DOM), skipLibCheck: false,
  // types: [] (no @types/node) — nothing ambient may be relied on.
  execFileSync(process.execPath, [tsc, '-p', consumerDir], { stdio: 'pipe' });
});
