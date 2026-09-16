import test from "node:test";
import assert from "node:assert/strict";

// Same-package unit test: relative ../src import (resolved by tsx; sibling @automatalabs/*
// deps it pulls in resolve to their built dist, which `pnpm test` builds first).
import { AcpAgent, createAcpRunner, isAcpAgentTurnError, probeHarnessConfig, selectBackend } from "../src/index.js";

test("@automatalabs/acp-agents public entry is reachable via ../src", () => {
  assert.equal(typeof createAcpRunner, "function");
  assert.equal(typeof selectBackend, "function");
  assert.equal(typeof probeHarnessConfig, "function");
  assert.equal(typeof AcpAgent, "function");
  assert.equal(typeof isAcpAgentTurnError, "function");
});
