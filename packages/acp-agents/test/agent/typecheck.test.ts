// The gate behind every compile-gate in test/agent/**: actually type-check the SDK suite (and the
// catalog tests moved down from workflows) with `tsc -p tsconfig.test.json`. The build
// tsconfig.json is src-only and tsx never type-checks, so this spawned compile is the ONLY thing
// that makes a dropped/renamed SDK export or a stale duck type fail `pnpm test` (mirrors the
// facade gate in packages/workflows/test/sdk.test.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("tsc type-checks the SDK suite and the moved catalog tests (tsconfig.test.json)", () => {
  const require = createRequire(import.meta.url);
  const tsc = require.resolve("typescript/lib/tsc.js");
  const pkgDir = fileURLToPath(new URL("../..", import.meta.url));
  const result = spawnSync(process.execPath, [tsc, "-p", join(pkgDir, "tsconfig.test.json"), "--noEmit"], {
    cwd: pkgDir,
    encoding: "utf8",
    timeout: 180_000,
  });
  assert.equal(result.status, 0, `tsc found type errors:\n${result.stdout}${result.stderr}`);
});
