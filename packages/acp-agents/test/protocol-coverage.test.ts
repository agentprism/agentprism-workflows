import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import { AGENT_METHOD_COVERAGE, CLIENT_METHOD_COVERAGE } from "../src/index.js";

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function assertSameSet(actual: Iterable<string>, expected: Iterable<string>, label: string): void {
  assert.deepEqual(sorted(actual), sorted(expected), `${label} coverage must match the installed SDK`);
}

test("client method coverage classifies every installed SDK client method", () => {
  // PROTOCOL_METHODS (`$/cancel_request`) is SDK-internal JSON-RPC plumbing, not ACP surface
  // this runner serves or drives.
  assertSameSet(Object.keys(CLIENT_METHOD_COVERAGE), Object.values(CLIENT_METHODS), "client method");
});

test("agent method coverage classifies every installed SDK agent method", () => {
  assertSameSet(Object.keys(AGENT_METHOD_COVERAGE), Object.values(AGENT_METHODS), "agent method");
});
