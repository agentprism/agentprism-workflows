// ACP adapter classifications become typed seam errors; generic mapping never parses prose.
import test from "node:test";
import assert from "node:assert/strict";
import { RequestError } from "@agentclientprotocol/sdk";
import { WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import {
  ACP_AUTH_REQUIRED_ERROR_CODE,
  ClaudeBackend,
  CodexBackend,
  errorText,
  mapThrownError,
  OpenCodeBackend,
} from "../src/index.js";

const LIVE_USAGE_CREDITS =
  "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.";

test("errorText extracts a message from Error, string, {message}, and falls back to JSON/String", () => {
  assert.equal(errorText(new Error("boom")), "boom");
  assert.equal(errorText("plain string"), "plain string");
  assert.equal(errorText({ message: "objmsg" }), "objmsg");
  assert.equal(errorText({ a: 1 }), JSON.stringify({ a: 1 }));
  assert.equal(errorText(42), "42");
});

test("codex-acp usageLimitExceeded data maps to PROVIDER_USAGE_LIMIT with structured reset metadata", () => {
  // Exact @automatalabs/codex-acp@1.6.3 shape from createTurnErrorData(): provider text plus the
  // Codex app-server's typed codexErrorInfo discriminant in RequestError.data.
  const wall = RequestError.internalError({
    message: "You've hit your usage limit.",
    codexErrorInfo: "usageLimitExceeded",
  });
  assert.equal(wall.code, -32603);
  assert.equal(wall.message, "Internal error");
  const mapped = mapThrownError(wall, {
    label: "codex-agent",
    backendId: "codex",
    backend: new CodexBackend(),
    providerErrorMetadata: { resetAt: "2026-07-15T08:00:00.000Z" },
  });
  assert.ok(mapped instanceof WorkflowError);
  assert.equal(mapped.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
  assert.equal(mapped.recoverable, false);
  assert.equal(mapped.resetHint, "Resets at 2026-07-15T08:00:00.000Z");
  assert.equal(mapped.agentLabel, "codex-agent");
  assert.deepEqual(mapped.providerUsageLimitContext, {
    backendId: "codex",
    source: "provider",
    providerCode: "usageLimitExceeded",
    resetAt: "2026-07-15T08:00:00.000Z",
  });
  assert.match(mapped.message, /usage limit/i); // provider text surfaced, not just "Internal error"
});

test("codex-acp typed HTTP 429 data maps without consulting provider prose", () => {
  const wall = RequestError.internalError({
    message: "localized provider failure",
    codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
  });
  const mapped = mapThrownError(wall, { backendId: "codex", backend: new CodexBackend() });
  assert.equal(mapped.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
  assert.equal(mapped.providerUsageLimitContext?.providerCode, "http_429");
});

test("claude-agent-acp errorKind maps the exact live #149 text and structured reset epoch", () => {
  const wall = RequestError.internalError({ errorKind: "billing_error" }, LIVE_USAGE_CREDITS);
  const mapped = mapThrownError(wall, {
    label: "fable-reviewer",
    backendId: "claude",
    backend: new ClaudeBackend(),
    providerErrorMetadata: { resetAt: "2026-07-15T09:00:00.000Z" },
  });
  assert.equal(mapped.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
  assert.equal(mapped.recoverable, false);
  assert.equal(mapped.resetHint, "Resets at 2026-07-15T09:00:00.000Z");
  assert.deepEqual(mapped.providerUsageLimitContext, {
    backendId: "claude",
    source: "provider",
    providerCode: "billing_error",
    resetAt: "2026-07-15T09:00:00.000Z",
  });
  assert.equal(mapped.message.includes(LIVE_USAGE_CREDITS), true);
});

test("legacy Claude and current OpenCode adapter fallbacks cover the live #149 message only at the boundary", () => {
  const claude = mapThrownError(new Error(LIVE_USAGE_CREDITS), {
    backendId: "claude",
    backend: new ClaudeBackend(),
  });
  const opencode = mapThrownError(RequestError.internalError({ errorName: "APIError" }, LIVE_USAGE_CREDITS), {
    backendId: "opencode",
    backend: new OpenCodeBackend(),
  });
  assert.equal(claude.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
  assert.equal(claude.providerUsageLimitContext?.source, "adapter_fallback");
  assert.equal(opencode.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
  assert.equal(opencode.providerUsageLimitContext?.source, "adapter_fallback");
});

test("billing endpoint unavailable is not a provider usage limit", () => {
  for (const backend of [new ClaudeBackend(), new OpenCodeBackend(), new CodexBackend()]) {
    const mapped = mapThrownError(new Error("billing endpoint unavailable"), {
      backendId: backend.id,
      backend,
    });
    assert.equal(mapped.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR, backend.id);
    assert.equal(mapped.recoverable, true, backend.id);
  }
});

test("provider-looking prose without an adapter discriminant remains recoverable", () => {
  const mapped = mapThrownError(new Error("Usage limit reached. Resets at 9:00 AM."));
  assert.equal(mapped.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
  assert.equal(mapped.recoverable, true);
  assert.equal(mapped.resetHint, undefined);
  assert.equal(mapped.providerUsageLimitContext, undefined);
  assert.equal(mapped.message, "Usage limit reached. Resets at 9:00 AM.");
});

test("errorText folds RequestError .data text in for display; leaves non-text data alone", () => {
  assert.match(errorText(RequestError.internalError({ message: "quota exceeded" })), /quota exceeded/);
  // A `.data` with no message/details string adds nothing (e.g. methodNotFound's `{ method }`).
  assert.equal(errorText(RequestError.methodNotFound("session/foo")), `"Method not found": session/foo`);
});

test("ACP auth-required RequestError => AUTH_REQUIRED, non-recoverable, with backend and method hint", () => {
  const mapped = mapThrownError(RequestError.authRequired(undefined, "login first"), {
    label: "auth-agent",
    backendId: "codex",
    authMethods: [
      { id: "api-key", name: "API Key" },
      { id: "chat-gpt", name: "ChatGPT" },
    ],
  });
  assert.equal(RequestError.authRequired().code, ACP_AUTH_REQUIRED_ERROR_CODE);
  assert.equal(mapped.code, WorkflowErrorCode.AUTH_REQUIRED);
  assert.equal(mapped.recoverable, false);
  assert.equal(mapped.agentLabel, "auth-agent");
  assert.match(mapped.message, /codex/);
  assert.match(mapped.message, /api-key, chat-gpt/);
  assert.match(mapped.message, /login first/);
});

test("-32000 with ANY message classifies as AUTH_REQUIRED (localized/rephrased text still auth)", () => {
  // The SDK reserves -32000 exclusively for authRequired, so the code alone is authoritative —
  // a conformant agent that localizes or rephrases the message must still route to pause-for-auth.
  for (const message of [
    "Authentication required: login first", // canonical English
    "Authentifizierung erforderlich", // German — no English phrase at all
    "认证是必需的", // Chinese
    "please sign in to continue", // rephrased English, no "authentication required"
    "", // empty message
  ]) {
    const mapped = mapThrownError({ code: ACP_AUTH_REQUIRED_ERROR_CODE, message });
    assert.equal(mapped.code, WorkflowErrorCode.AUTH_REQUIRED, `-32000 + ${JSON.stringify(message)}`);
    assert.equal(mapped.recoverable, false);
  }
});

test("a NON-reserved code carrying the 'authentication required' phrase classifies as AUTH_REQUIRED", () => {
  // Fallback path: a non-conformant agent that signals auth in prose without the reserved code.
  const mapped = mapThrownError({ code: -31999, message: "Authentication required to proceed" });
  assert.equal(mapped.code, WorkflowErrorCode.AUTH_REQUIRED);
  assert.equal(mapped.recoverable, false);
  // No `code` at all (plain Error) but the phrase present => still auth via the string fallback.
  assert.equal(mapThrownError(new Error("authentication required")).code, WorkflowErrorCode.AUTH_REQUIRED);
});

test("a DIFFERENT reserved code that merely MENTIONS the auth phrase never mis-routes to auth", () => {
  // -32603 (internal error) + the phrase must stay a recoverable AGENT_EXECUTION_ERROR, not auth.
  const internal = mapThrownError({ code: -32603, message: "Internal error: authentication required upstream" });
  assert.equal(internal.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
  assert.equal(internal.recoverable, true);
  // Every other reserved non-auth code is likewise immune to the phrase.
  for (const code of [-32700, -32600, -32601, -32602, -32800, -32002]) {
    const mapped = mapThrownError({ code, message: "authentication required" });
    assert.equal(mapped.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR, `reserved ${code} must not classify as auth`);
  }
});

test("Pi child cleanup is exact, redacted, and non-recoverable while unknown -32603 stays recoverable", () => {
  const original = {
    code: -32603,
    message: "secret-bearing adapter prose",
    data: { errorKind: "child_cleanup_error", details: { remainingChildren: 2 } },
  };
  const mapped = mapThrownError(original, "pi-agent");
  assert.equal(mapped.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
  assert.equal(mapped.recoverable, false);
  assert.equal(mapped.message, "child process cleanup failed");
  assert.equal(mapped.agentLabel, "pi-agent");
  assert.equal(mapped.details, original);
  assert.doesNotMatch(mapped.message, /secret-bearing/);

  for (const candidate of [
    { ...original, code: -32602 },
    { ...original, data: { errorKind: "other" } },
    { code: -32603, message: "unknown internal failure" },
  ]) {
    const generic = mapThrownError(candidate);
    assert.equal(generic.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(generic.recoverable, true);
  }
});

test("AUTH_REQUIRED authContext carries advertised method ids/types/names + backendId only", () => {
  const mapped = mapThrownError(RequestError.authRequired(undefined, "login first"), {
    label: "auth-agent",
    backendId: "codex",
    authMethods: [
      { id: "api-key", name: "API Key", _meta: { "api-key": { provider: "openai" } } }, // non-gateway _meta => still "agent"
      { id: "chat-gpt", name: "ChatGPT" }, // no `type` => defaults to "agent"
      { type: "terminal", id: "claude-login", name: "Terminal Login" },
    ],
  });
  assert.equal(mapped.code, WorkflowErrorCode.AUTH_REQUIRED);
  assert.deepEqual(mapped.authContext, {
    backendId: "codex",
    methods: [
      { id: "api-key", type: "agent", name: "API Key" },
      { id: "chat-gpt", type: "agent", name: "ChatGPT" },
      { id: "claude-login", type: "terminal", name: "Terminal Login" },
    ],
  });
  // No secret/_meta/env material leaks into the structured context (Principle 9).
  assert.equal(JSON.stringify(mapped.authContext).includes("_meta"), false);
});

test("AUTH_REQUIRED with no advertised methods yields an empty methods array (backendId still carried)", () => {
  const mapped = mapThrownError({ code: ACP_AUTH_REQUIRED_ERROR_CODE, message: "Authentication required" }, {
    backendId: "custom",
  });
  assert.deepEqual(mapped.authContext, { backendId: "custom", methods: [] });
});

test("a non-wall fault => recoverable AGENT_EXECUTION_ERROR (engine retries it)", () => {
  const mapped = mapThrownError(new Error("ECONNRESET: socket hang up"), "lbl");
  assert.equal(mapped.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
  assert.equal(mapped.recoverable, true);
  assert.equal(mapped.resetHint, undefined);
  assert.equal(mapped.agentLabel, "lbl");
});

test("transient overloaded/5xx errors are NOT walls (stay recoverable)", () => {
  for (const msg of ["overloaded_error", "503 Service Unavailable", "internal server error"]) {
    assert.equal(mapThrownError(new Error(msg)).code, WorkflowErrorCode.AGENT_EXECUTION_ERROR, msg);
  }
});

test("an in-band WorkflowError passes through unchanged (instanceof identity preserved)", () => {
  const original = new WorkflowError("no output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, { recoverable: true });
  assert.equal(mapThrownError(original, "lbl"), original); // same reference, not re-wrapped
  const schema = new WorkflowError("bad", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
  assert.equal(mapThrownError(schema), schema);
});
