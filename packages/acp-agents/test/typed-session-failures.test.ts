// Unit coverage for codex-acp's negotiated typed-session-failures extension, client side: the
// initialize advertisement, the wire parse, the revision/identity supersession rules, and the
// category -> seam-error mapping.
//
// The advertisement is asserted against a faithful transcription of the SERVER's own acceptance
// gate (`clientSupportsTypedSessionFailures` in packages/codex-acp/src/CodexAcpServer.ts), and the
// mirrored wire names are asserted against the fork's source of truth
// (packages/codex-acp/src/AirExtension.ts) — acp-agents cannot import either (the fork publishes a
// bundled `dist/index.js` with no type declarations and no exports map, and a source import across
// packages would invert the dependency direction), so the mirror is pinned by test instead.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import {
  CODEX_AIR_EXTENSION_VERSION,
  CODEX_AIR_META_KEYS,
  WorkflowErrorCode,
} from "@automatalabs/shared-types";
import {
  CodexBackend,
  TYPED_SESSION_FAILURE_CLIENT_CAPABILITY,
  clientCapabilitiesFor,
  mapTypedSessionFailure,
  readTypedSessionFailure,
  supersedesTypedSessionFailure,
  type TypedSessionFailure,
} from "../src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** VERBATIM transcription of codex-acp's `clientSupportsTypedSessionFailures`
 *  (packages/codex-acp/src/CodexAcpServer.ts) — the gate our advertisement must satisfy. */
function clientSupportsTypedSessionFailures(capabilities: ClientCapabilities | null): boolean {
  const jetbrains = capabilities?._meta?.[CODEX_AIR_META_KEYS.namespace] as Record<string, unknown> | undefined;
  const air = jetbrains?.[CODEX_AIR_META_KEYS.extension] as Record<string, unknown> | undefined;
  const version = air?.[CODEX_AIR_META_KEYS.version];
  const supported = air?.[CODEX_AIR_META_KEYS.capabilities];
  return typeof version === "number"
    && Number.isInteger(version)
    && version >= CODEX_AIR_EXTENSION_VERSION
    && Array.isArray(supported)
    && supported.includes(CODEX_AIR_META_KEYS.sessionFailure);
}

function failure(overrides: Partial<TypedSessionFailure> = {}): TypedSessionFailure {
  return {
    id: "turn-1:error",
    revision: 1,
    phase: "active",
    category: "internal_error",
    source: "codex",
    safeMessage: "Codex encountered an internal error.",
    retryable: true,
    actions: ["retry"],
    ...overrides,
  } as TypedSessionFailure;
}

/** The wire `_meta` envelope both delivery channels use. */
function meta(payload: unknown, version: number = CODEX_AIR_EXTENSION_VERSION): Record<string, unknown> {
  return {
    [CODEX_AIR_META_KEYS.namespace]: {
      [CODEX_AIR_META_KEYS.extension]: {
        [CODEX_AIR_META_KEYS.version]: version,
        [CODEX_AIR_META_KEYS.sessionFailure]: payload,
      },
    },
  };
}

// ---- the mirror is still the fork's contract ----------------------------------------

test("the mirrored AIR wire names still match packages/codex-acp/src/AirExtension.ts", () => {
  const source = readFileSync(join(repoRoot, "packages/codex-acp/src/AirExtension.ts"), "utf-8");
  const declarations: Array<[string, string]> = [
    ["JETBRAINS_META_KEY", CODEX_AIR_META_KEYS.namespace],
    ["AIR_META_KEY", CODEX_AIR_META_KEYS.extension],
    ["AIR_EXTENSION_VERSION_KEY", CODEX_AIR_META_KEYS.version],
    ["AIR_EXTENSION_CAPABILITIES_KEY", CODEX_AIR_META_KEYS.capabilities],
    ["AIR_SESSION_FAILURE_KEY", CODEX_AIR_META_KEYS.sessionFailure],
  ];
  for (const [constant, mirrored] of declarations) {
    assert.ok(
      source.includes(`export const ${constant} = "${mirrored}";`),
      `AirExtension.ts must still declare ${constant} = "${mirrored}"`,
    );
  }
  assert.ok(
    source.includes(`export const AIR_EXTENSION_VERSION = ${CODEX_AIR_EXTENSION_VERSION};`),
    `AirExtension.ts must still declare AIR_EXTENSION_VERSION = ${CODEX_AIR_EXTENSION_VERSION}`,
  );
});

// ---- advertisement -------------------------------------------------------------------

test("the advertised capability block is exactly what the codex-acp gate accepts", () => {
  assert.deepEqual(TYPED_SESSION_FAILURE_CLIENT_CAPABILITY, {
    jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } },
  });
  assert.equal(
    clientSupportsTypedSessionFailures({ _meta: TYPED_SESSION_FAILURE_CLIENT_CAPABILITY }),
    true,
  );
});

test("the codex backend declares the advertisement; the other built-ins declare none", async () => {
  const { ClaudeBackend, OpenCodeBackend, PiBackend } = await import("../src/index.js");
  assert.equal(new CodexBackend().clientCapabilityMeta, TYPED_SESSION_FAILURE_CLIENT_CAPABILITY);
  assert.equal(new ClaudeBackend().clientCapabilityMeta, undefined);
  assert.equal(new OpenCodeBackend().clientCapabilityMeta, undefined);
  assert.equal(new PiBackend().clientCapabilityMeta, undefined);
});

test("clientCapabilitiesFor folds the backend advertisement into _meta beside terminal-auth", () => {
  const withMeta = clientCapabilitiesFor(undefined, { meta: TYPED_SESSION_FAILURE_CLIENT_CAPABILITY });
  assert.equal(clientSupportsTypedSessionFailures(withMeta), true);

  // It coexists with the auth advertisement's own top-level `_meta` key rather than replacing it.
  const both = clientCapabilitiesFor(undefined, {
    auth: { terminal: true },
    meta: TYPED_SESSION_FAILURE_CLIENT_CAPABILITY,
  });
  assert.equal((both._meta as Record<string, unknown>)["terminal-auth"], true);
  assert.equal(clientSupportsTypedSessionFailures(both), true);

  // No backend meta => byte-identical to the pre-extension advertisement (no `_meta` at all).
  assert.deepEqual(clientCapabilitiesFor(undefined, { meta: {} }), clientCapabilitiesFor(undefined));
  assert.equal(clientCapabilitiesFor(undefined)._meta, undefined);
});

test("the transcribed gate is discriminating: near-miss advertisements are rejected", () => {
  assert.equal(clientSupportsTypedSessionFailures(null), false);
  assert.equal(clientSupportsTypedSessionFailures({}), false);
  assert.equal(
    clientSupportsTypedSessionFailures({ _meta: { jetbrains: { air: { version: 0, capabilities: ["sessionFailure"] } } } }),
    false,
    "a version below the server's own is rejected",
  );
  assert.equal(
    clientSupportsTypedSessionFailures({ _meta: { jetbrains: { air: { version: 1, capabilities: [] } } } }),
    false,
    "the capability must be listed",
  );
  assert.equal(
    clientSupportsTypedSessionFailures({ _meta: { jetbrains: { air: { version: 1.5, capabilities: ["sessionFailure"] } } } }),
    false,
    "a non-integer version is rejected",
  );
});

// ---- wire parse ----------------------------------------------------------------------

test("readTypedSessionFailure reads a well-formed payload and drops unknown actions", () => {
  const parsed = readTypedSessionFailure(
    meta({
      id: "turn-7:error",
      revision: 3,
      phase: "active",
      category: "rate_limited",
      source: "codex",
      safeMessage: "The Codex rate limit was reached.",
      retryable: true,
      actions: ["retry", "teleport"],
      turnId: "turn-7",
    }),
  );
  assert.deepEqual(parsed, {
    id: "turn-7:error",
    revision: 3,
    phase: "active",
    category: "rate_limited",
    source: "codex",
    safeMessage: "The Codex rate limit was reached.",
    retryable: true,
    actions: ["retry"],
    turnId: "turn-7",
  });
});

test("readTypedSessionFailure returns undefined for every _meta that carries no typed failure", () => {
  for (const value of [
    undefined,
    null,
    {},
    { quota: { plan: "pro" } },
    { jetbrains: {} },
    { jetbrains: { air: {} } },
    { jetbrains: { air: [] } },
    { jetbrains: [{ air: { version: 1 } }] },
    meta(undefined),
    meta("not-an-object"),
  ]) {
    assert.equal(readTypedSessionFailure(value), undefined, JSON.stringify(value ?? null));
  }
});

test("readTypedSessionFailure rejects an out-of-contract version", () => {
  const payload = failure();
  assert.ok(readTypedSessionFailure(meta(payload, CODEX_AIR_EXTENSION_VERSION)));
  assert.equal(readTypedSessionFailure(meta(payload, CODEX_AIR_EXTENSION_VERSION + 1)), undefined);
  assert.equal(readTypedSessionFailure(meta(payload, 0)), undefined);
  assert.equal(readTypedSessionFailure(meta(payload, 1.5)), undefined);
  assert.equal(readTypedSessionFailure(meta(payload, "1" as unknown as number)), undefined);
});

test("readTypedSessionFailure rejects a malformed failure record rather than half-trusting it", () => {
  const malformed: Array<Record<string, unknown>> = [
    { ...failure(), id: "" },
    { ...failure(), id: 7 },
    { ...failure(), revision: "3" },
    { ...failure(), revision: 1.5 },
    { ...failure(), phase: "pending" },
    { ...failure(), category: "" },
    { ...failure(), source: 1 },
    { ...failure(), safeMessage: null },
    { ...failure(), retryable: "yes" },
    { ...failure(), actions: "retry" },
  ];
  for (const payload of malformed) {
    assert.equal(readTypedSessionFailure(meta(payload)), undefined, JSON.stringify(payload));
  }
});

test("readTypedSessionFailure carries an unrecognized category through verbatim", () => {
  const parsed = readTypedSessionFailure(meta(failure({ category: "sandbox_revoked", retryable: false })));
  assert.equal(parsed?.category, "sandbox_revoked");
  assert.equal(parsed?.retryable, false);
});

// ---- supersession --------------------------------------------------------------------

test("supersession: same id needs a strictly greater revision; a different id always wins", () => {
  const latched = failure({ id: "a", revision: 2 });
  assert.equal(supersedesTypedSessionFailure(undefined, latched), true);
  assert.equal(supersedesTypedSessionFailure(latched, failure({ id: "a", revision: 3 })), true);
  assert.equal(supersedesTypedSessionFailure(latched, failure({ id: "a", revision: 2 })), false);
  assert.equal(supersedesTypedSessionFailure(latched, failure({ id: "a", revision: 1 })), false);
  assert.equal(supersedesTypedSessionFailure(latched, failure({ id: "b", revision: 1 })), true);
  // A stale `cleared` frame cannot retire a newer active record.
  assert.equal(
    supersedesTypedSessionFailure(latched, failure({ id: "a", revision: 1, phase: "cleared" })),
    false,
  );
});

// ---- category -> seam error ----------------------------------------------------------

test("auth_required maps to AUTH_REQUIRED with the advertised-method auth context", () => {
  const mapped = mapTypedSessionFailure(
    failure({ category: "auth_required", retryable: false, actions: ["login"], safeMessage: "Sign in to continue using Codex." }),
    {
      label: "codex-agent",
      backendId: "codex",
      authMethods: [{ id: "api-key", name: "API Key" }, { id: "chat-gpt", name: "ChatGPT" }],
    },
  );
  assert.equal(mapped.code, WorkflowErrorCode.AUTH_REQUIRED);
  assert.equal(mapped.recoverable, false);
  assert.equal(mapped.agentLabel, "codex-agent");
  assert.deepEqual(mapped.authContext, {
    backendId: "codex",
    methods: [
      { id: "api-key", type: "agent", name: "API Key" },
      { id: "chat-gpt", type: "agent", name: "ChatGPT" },
    ],
  });
  assert.match(mapped.message, /requires authentication: Sign in to continue using Codex\./);
  assert.match(mapped.message, /run authenticate\(\) with one of: api-key, chat-gpt/);
});

test("quota_exhausted and rate_limited map to a resumable PROVIDER_USAGE_LIMIT", () => {
  for (const category of ["quota_exhausted", "rate_limited"] as const) {
    const mapped = mapTypedSessionFailure(failure({ category, retryable: category === "rate_limited" }), {
      backendId: "codex",
      providerErrorMetadata: { resetAt: "2026-07-15T08:00:00.000Z" },
    });
    assert.equal(mapped.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
    // Non-recoverable even for the retryable rate limit: the code's contract is "pause + resume",
    // which beats retrying straight back into the same wall.
    assert.equal(mapped.recoverable, false, category);
    assert.equal(mapped.resetHint, "Resets at 2026-07-15T08:00:00.000Z");
    assert.deepEqual(mapped.providerUsageLimitContext, {
      backendId: "codex",
      source: "provider",
      providerCode: category,
      resetAt: "2026-07-15T08:00:00.000Z",
    });
  }
});

test("PROVIDER_USAGE_LIMIT omits reset metadata the agent never supplied", () => {
  const mapped = mapTypedSessionFailure(failure({ category: "quota_exhausted" }), { backendId: "codex" });
  assert.equal(mapped.resetHint, undefined);
  assert.deepEqual(mapped.providerUsageLimitContext, {
    backendId: "codex",
    source: "provider",
    providerCode: "quota_exhausted",
  });
});

test("every remaining category becomes AGENT_EXECUTION_ERROR with recoverable = retryable", () => {
  const expectations: Array<[string, boolean]> = [
    ["transport_lost", true],
    ["overloaded", true],
    ["provider_error", true],
    ["internal_error", true],
    ["context_exhausted", false],
    ["budget_exhausted", false],
    ["policy_denied", false],
    ["bad_request", false],
    // An unrecognized category from a newer server is classified by `retryable` alone.
    ["sandbox_revoked", false],
  ];
  for (const [category, retryable] of expectations) {
    const mapped = mapTypedSessionFailure(failure({ category, retryable }), { backendId: "codex" });
    assert.equal(mapped.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR, category);
    assert.equal(mapped.recoverable, retryable, category);
  }
});

test("the mapped message and details carry the sanitized text, category, and suggested actions", () => {
  const raised = failure({
    category: "transport_lost",
    safeMessage: "Connection to Codex was lost.",
    retryable: true,
    actions: ["reconnect", "retry"],
  });
  const mapped = mapTypedSessionFailure(raised, { backendId: "codex" });
  assert.equal(
    mapped.message,
    "Connection to Codex was lost. (codex typed failure: transport_lost; suggested: reconnect, retry)",
  );
  assert.deepEqual(mapped.details, raised);

  const actionless = mapTypedSessionFailure(failure({ category: "policy_denied", retryable: false, actions: [] }), {});
  assert.match(actionless.message, /\(codex typed failure: policy_denied\)$/);
});
