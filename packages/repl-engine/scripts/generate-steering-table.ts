/**
 * Regenerate the checked-in per-backend steering mechanism table (the
 * roadmap doc's generated documentation — see `src/steering-table.ts`):
 * `pnpm --filter @automatalabs/repl-engine generate:steering-table`.
 * The gate test (`test/steering-table.test.ts`) fails when the checked-in
 * document drifts from what this script produces.
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { generateSteeringMechanismTable } from '../src/steering-table.js';

const outPath = fileURLToPath(new URL('../docs/steering-mechanism-table.md', import.meta.url));
await writeFile(outPath, generateSteeringMechanismTable(), 'utf8');
console.log(`wrote ${outPath}`);
