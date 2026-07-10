import test from "node:test";
import assert from "node:assert/strict";

// Same-package unit test: import internals relatively (../src/*.js), exactly like pi's
// tests/*.test.ts. tsx rewrites the .js specifier to the .ts source at run time.
import { CODEX_CUSTOM_CAPABILITY_NAMESPACE, CODEX_META_KEYS, META_KEYS } from "../src/index.js";
import type { CheckpointContext } from "../src/index.js";

test("@automatalabs/shared-types public entry is reachable via ../src", () => {
  assert.equal(typeof META_KEYS, "object");
  // Keys are bare (un-namespaced), mirroring the target Codex param names.
  assert.equal(META_KEYS.outputSchema, "outputSchema");
  assert.equal(META_KEYS.runId, "runId");
});

test("CheckpointContext is exported from the public barrel", () => {
  const context: CheckpointContext = {
    callIndex: 0,
    hash: "hash",
    prompt: "Continue?",
    kind: "confirm",
  };
  assert.equal(context.kind, "confirm");
});

test("cross-repo wire literals: the fork namespace and Codex `_meta` keys never drift", () => {
  // These exact strings are the wire contract with the @automatalabs/codex-acp fork (it
  // advertises agentCapabilities._meta[NAMESPACE] = { outputSchema, baseInstructions,
  // developerInstructions } and reads the same-named bare `_meta` keys). Pin the literals so a
  // rename here fails THIS suite instead of silently breaking interop with the published fork.
  assert.equal(CODEX_CUSTOM_CAPABILITY_NAMESPACE, "@automatalabs/codex-acp");
  assert.equal(CODEX_META_KEYS.baseInstructions, "baseInstructions");
  assert.equal(CODEX_META_KEYS.developerInstructions, "developerInstructions");
});
