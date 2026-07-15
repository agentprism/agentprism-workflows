import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RECORDING_UNUSABLE_REASONS,
  REPLAY_DIVERGENCE_KINDS,
} from "../src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const api = readFileSync(join(repoRoot, "docs/api.md"), "utf8");

test("isolation refusal documentation covers the frozen runtime vocabularies", () => {
  for (const reason of RECORDING_UNUSABLE_REASONS) {
    assert.ok(api.includes(`\`${reason}\``), `docs/api.md must document recording refusal ${reason}`);
  }
  for (const kind of REPLAY_DIVERGENCE_KINDS) {
    assert.ok(api.includes(`\`${kind}\``), `docs/api.md must document replay divergence ${kind}`);
  }
});

test("isolation documentation retains the canonical cost-surface warning", () => {
  assert.ok(
    api.includes(
      "An isolation run's own per-call token figures (chars/4 estimates for served calls) are not comparable to a normal run's; the `ReplayReport` — `recordedUsage` vs `liveUsage` — is the only valid cost surface.",
    ),
    "docs/api.md must retain the verbatim isolation cost-surface sentence",
  );
});
