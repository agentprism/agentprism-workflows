import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import type { ClientSideConnection, InitializeResponse } from "@agentclientprotocol/sdk";
import {
  ACP_AUTH_REQUIRED_CODE_EXCLUSIVE,
  ACP_EXTENSION_SUPPORT_MATRIX,
  AGENT_METHOD_COVERAGE,
  AUTH_CAPABILITY_KEYS,
  AUTH_META_CONVENTION_KEYS,
  AUTH_META_MATRIX,
  CLIENT_METHOD_COVERAGE,
  CODEX_SPAWN_AUTH_ENV,
  HANDLED_AUTH_METHOD_TYPES,
  PI_ACP_PROTOCOL_CONTRACT,
  SESSION_STEERING_METHOD,
  assertAuthCapabilityShape,
  clientCapabilitiesFor,
} from "../src/index.js";

type Expect<T extends true> = T;
type _InitializeMetaSchemaPinned = Expect<
  Exclude<InitializeResponse["_meta"], null | undefined> extends Record<string, unknown>
    ? true
    : false
>;

function compileGenericSdkOverloads(connection: ClientSideConnection): void {
  const request: Promise<{ exact: true }> = connection.request<
    { exact: true },
    { value: string }
  >("example.test/generic", { value: "verbatim" });
  const notification: Promise<void> = connection.notify<{ value: string }>(
    "example.test/notification",
    { value: "verbatim" },
  );
  void request;
  void notification;
}
void compileGenericSdkOverloads;

test("SDK initialize metadata schema and generic request/notify overloads remain present", () => {
  const meta: InitializeResponse["_meta"] = { nested: { supported: true } };
  assert.deepEqual(meta, { nested: { supported: true } });
});

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
    16,
    "agent driven count excluding initialize should match docs",
  );
  assert.equal(
    Object.values(AGENT_METHOD_COVERAGE).filter((coverage) => coverage === "guarded").length,
    0,
    "agent guarded count should match docs",
  );
  assert.equal(
    Object.hasOwn(AGENT_METHOD_COVERAGE, SESSION_STEERING_METHOD),
    false,
    "the steering vendor extension must not be counted as a standard SDK agent method",
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

// §4.6.4 item 3 — the base dispatcher handles exactly the two SDK AuthMethod discriminants (ACP
// schema 1.21.0 removed `env_var`; the compile-time `_AuthMethodEnvVarAbsent` pin keeps it out).
test("HANDLED_AUTH_METHOD_TYPES is exactly agent/terminal", () => {
  assert.deepEqual([...HANDLED_AUTH_METHOD_TYPES], ["agent", "terminal"]);
});

// §4.6.4 items 4–5 — the cross-agent `_meta` convention surfaces the base layer keys on must still be
// present in the INSTALLED agent dists (claude/codex; opencode ships a compiled binary, §3.4), so an
// agent bump that moves a `_meta` surface fails the build BEFORE release, never silently.
const requireAcp = createRequire(new URL("../package.json", import.meta.url));
function readDist(spec: string): string {
  return readFileSync(requireAcp.resolve(spec), "utf8");
}
const CLAUDE_DIST = readDist("@agentclientprotocol/claude-agent-acp/dist/acp-agent.js");
const CODEX_DIST = readDist("@automatalabs/codex-acp");
const PI_DIST_DIR = dirname(requireAcp.resolve("@automatalabs/pi-acp"));
const PI_AGENT_DIST = readFileSync(join(PI_DIST_DIR, "agent.js"), "utf8");
const PI_AUTH_DIST = readFileSync(join(PI_DIST_DIR, "auth.js"), "utf8");
const PI_ERRORS_DIST = readFileSync(join(PI_DIST_DIR, "errors.js"), "utf8");

test("the cross-agent _meta convention keys are pinned and still present in the agent dists", () => {
  // The literal key names the base layer keys on (§1 intro) — not SDK schema fields.
  assert.deepEqual(AUTH_META_CONVENTION_KEYS, { gateway: "gateway", terminalAuth: "terminal-auth", apiKey: "api-key" });
  assert.equal(CODEX_SPAWN_AUTH_ENV, "DEFAULT_AUTH_REQUEST");

  // claude advertises the gateway `_meta` and the terminal-auth launch hint.
  assert.ok(CLAUDE_DIST.includes(AUTH_META_CONVENTION_KEYS.gateway), "claude dist still emits `gateway`");
  assert.ok(CLAUDE_DIST.includes(AUTH_META_CONVENTION_KEYS.terminalAuth), "claude dist still emits `terminal-auth`");

  // codex advertises api-key/gateway `_meta` and reads the DEFAULT_AUTH_REQUEST startup channel.
  assert.ok(CODEX_DIST.includes(AUTH_META_CONVENTION_KEYS.apiKey), "codex dist still emits `api-key`");
  assert.ok(CODEX_DIST.includes(AUTH_META_CONVENTION_KEYS.gateway), "codex dist still emits `gateway`");
  assert.ok(CODEX_DIST.includes(CODEX_SPAWN_AUTH_ENV), "codex dist still reads DEFAULT_AUTH_REQUEST");
});

test("every dist-probed AUTH_META_MATRIX row's capability literal is present in that agent's dist", () => {
  for (const row of AUTH_META_MATRIX) {
    assert.equal(row.status, "supported-today", `${row.agent}/${row.capability} must describe delivered behavior`);
    assert.ok(!Object.hasOwn(row, "owner"), `${row.agent}/${row.capability} must not publish deferred ownership`);
    if (row.distProbe === "claude") {
      assert.ok(CLAUDE_DIST.includes(row.capability), `claude dist must still carry "${row.capability}" (§3.6)`);
    } else if (row.distProbe === "codex") {
      assert.ok(CODEX_DIST.includes(row.capability), `codex dist must still carry "${row.capability}" (§3.6)`);
    }
  }
  // The matrix covers all four agent buckets and stays non-empty.
  assert.ok(AUTH_META_MATRIX.length >= 8);
  assert.ok(AUTH_META_MATRIX.some((r) => r.agent === "opencode"));
});

test("the executable ACP extension matrix documents installed advertisements without runtime gating", () => {
  assert.deepEqual(ACP_EXTENSION_SUPPORT_MATRIX, [
    {
      agent: "claude",
      method: "_session/steering",
      disposition: "supported",
      distProbe: "claude",
    },
    {
      agent: "codex",
      method: "_session/steering",
      disposition: "supported",
      distProbe: "codex",
    },
    {
      agent: "opencode",
      method: "_session/steering",
      disposition: "not-advertised",
    },
    {
      agent: "pi",
      method: "_session/steering",
      disposition: "supported",
    },
    {
      agent: "claude",
      method: "_session/loaded_turn/query",
      disposition: "not-advertised",
      distProbe: "claude",
    },
    {
      agent: "codex",
      method: "_session/loaded_turn/query",
      disposition: "supported",
      distProbe: "codex",
    },
    {
      agent: "opencode",
      method: "_session/loaded_turn/query",
      disposition: "not-advertised",
    },
    {
      agent: "pi",
      method: "_session/loaded_turn/query",
      disposition: "supported",
    },
  ]);

  for (const row of ACP_EXTENSION_SUPPORT_MATRIX) {
    const dist =
      row.distProbe === "claude"
        ? CLAUDE_DIST
        : row.distProbe === "codex"
          ? CODEX_DIST
          : undefined;
    if (!dist) continue;
    // A `supported` disposition means the installed distribution implements the method AND
    // advertises it at initialize. `not-advertised` records distribution evidence only; this
    // matrix is never consulted to gate a runtime extension request.
    if (row.disposition === "supported") {
      assert.ok(dist.includes(row.method), `${row.agent} dist must implement ${row.method}`);
      if (row.method === "_session/steering") {
        assert.match(
          dist,
          // Anchor on the steering block itself; other `_meta` extension keys may precede
          // it (the jetbrains/air block, upstream 0.67.0) or follow it (the goal extension,
          // upstream #371) as siblings, so require neither that `steering` opens `_meta`
          // nor that `supported: true` is `_meta`'s last entry — only that the steering
          // block itself advertises exactly `supported: true`.
          /steering\s*:\s*\{\s*supported\s*:\s*true\s*,?\s*\}/,
          `${row.agent} dist must advertise top-level steering support`,
        );
      } else {
        assert.match(
          dist,
          /_meta\s*:\s*\{[\s\S]*?loadedTurn\s*:\s*\{\s*supported\s*:\s*true/,
          `${row.agent} dist must advertise top-level loaded-turn support`,
        );
      }
    } else {
      assert.ok(!dist.includes(row.method), `${row.agent} dist must NOT implement ${row.method} until the matrix is updated`);
    }
  }
});

// §4.6.4 item 5 — the code-only matcher (§1.5) relies on `-32000` being auth-exclusive.
test("the pinned auth-required code is the SDK's exclusively-reserved -32000", () => {
  assert.equal(ACP_AUTH_REQUIRED_CODE_EXCLUSIVE, -32000);
});

test("the first-class Pi backend pins the frozen pi-acp capability/auth/error surface", () => {
  assert.deepEqual(PI_ACP_PROTOCOL_CONTRACT, {
    mcpCapabilities: { http: true, sse: true },
    authMethodIds: ["pi-stored-credentials"],
    providerErrorKinds: ["auth_error", "rate_limit", "billing_error", "provider_error"],
  });
  assert.ok(PI_AGENT_DIST.includes("http: true"));
  assert.ok(PI_AGENT_DIST.includes("sse: true"));
  assert.ok(!PI_AGENT_DIST.includes("outputSchema: true"));
  for (const methodId of PI_ACP_PROTOCOL_CONTRACT.authMethodIds) {
    assert.ok(PI_AUTH_DIST.includes(methodId), `installed pi-acp auth dist must contain ${methodId}`);
  }
  for (const errorKind of PI_ACP_PROTOCOL_CONTRACT.providerErrorKinds) {
    assert.ok(PI_ERRORS_DIST.includes(errorKind), `installed pi-acp errors dist must contain ${errorKind}`);
  }
});
