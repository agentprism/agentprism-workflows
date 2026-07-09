import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import {
  AGENT_METHOD_COVERAGE,
  AUTH_CAPABILITY_KEYS,
  CLIENT_METHOD_COVERAGE,
  assertAuthCapabilityShape,
  clientCapabilitiesFor,
} from "../src/index.js";

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
  assert.equal(
    Object.values(CLIENT_METHOD_COVERAGE).filter((coverage) => coverage === "served").length,
    14,
    "client served count should match docs",
  );
});

test("agent method coverage classifies every installed SDK agent method", () => {
  assertSameSet(Object.keys(AGENT_METHOD_COVERAGE), Object.values(AGENT_METHODS), "agent method");
  assert.equal(
    Object.entries(AGENT_METHOD_COVERAGE).filter(
      ([method, coverage]) => method !== AGENT_METHODS.initialize && coverage === "driven",
    ).length,
    15,
    "agent driven count excluding initialize should match docs",
  );
  assert.equal(
    Object.values(AGENT_METHOD_COVERAGE).filter((coverage) => coverage === "guarded").length,
    1,
    "agent guarded count should match docs",
  );
});

// §4.6.4 item 1 — the client auth advertisement rides the SDK's UNSTABLE `AuthCapabilities` surface.
// Pin the emitted shape so a `@agentclientprotocol/sdk` bump that reshapes it trips the build.
test("clientCapabilitiesFor emits only the pinned SDK-1.2.1 AuthCapabilities keys", () => {
  const caps = clientCapabilitiesFor(undefined, { auth: { terminal: true, gateway: true } });
  assert.ok(caps.auth, "auth block advertised when a gate is requested");
  // Exactly `{ terminal, _meta }` — no extra/renamed keys.
  assert.deepEqual(Object.keys(caps.auth).sort(), [...AUTH_CAPABILITY_KEYS].sort());
  assert.doesNotThrow(() => assertAuthCapabilityShape(caps.auth));
  // The gateway-only and default-OFF shapes are also conformant (and null is vacuously fine).
  assert.doesNotThrow(() =>
    assertAuthCapabilityShape(clientCapabilitiesFor(undefined, { auth: { gateway: true } }).auth),
  );
  assert.doesNotThrow(() => assertAuthCapabilityShape(clientCapabilitiesFor(undefined).auth));
  assert.doesNotThrow(() => assertAuthCapabilityShape(undefined));
});

test("assertAuthCapabilityShape trips on a drifted (unpinned) auth key", () => {
  assert.throws(
    () => assertAuthCapabilityShape({ terminal: true, envVar: true } as never),
    /unpinned key "envVar"/,
  );
});
