// Supports area (4): the ACP failure -> WorkflowError classifier. Provider walls become
// PROVIDER_USAGE_LIMIT (non-recoverable + resetHint, gated on the ERROR channel only); in-band
// seam errors pass through untouched; everything else is a recoverable AGENT_EXECUTION_ERROR.
import test from "node:test";
import assert from "node:assert/strict";
import { RequestError } from "@agentclientprotocol/sdk";
import { WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { ACP_AUTH_REQUIRED_ERROR_CODE, errorText, mapThrownError } from "../src/index.js";

test("errorText extracts a message from Error, string, {message}, and falls back to JSON/String", () => {
  assert.equal(errorText(new Error("boom")), "boom");
  assert.equal(errorText("plain string"), "plain string");
  assert.equal(errorText({ message: "objmsg" }), "objmsg");
  assert.equal(errorText({ a: 1 }), JSON.stringify({ a: 1 }));
  assert.equal(errorText(42), "42");
});

test("provider wall => PROVIDER_USAGE_LIMIT, non-recoverable, with resetHint preserved", () => {
  const mapped = mapThrownError(new Error("Usage limit reached. Resets in 3 hours."), "weather-agent");
  assert.ok(mapped instanceof WorkflowError);
  assert.equal(mapped.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
  assert.equal(mapped.recoverable, false);
  assert.equal(mapped.resetHint, "Resets in 3 hours");
  assert.equal(mapped.agentLabel, "weather-agent");
  assert.equal(mapped.details instanceof Error, true);
});

test("codex-acp usageLimitExceeded RequestError (text in .data.message) => PROVIDER_USAGE_LIMIT + resetHint", () => {
  // Exact reconstructed shape from @automatalabs/codex-acp@1.6.1: usageLimitExceeded wraps the
  // provider text as RequestError.internalError(createTurnErrorData(...)) — code -32603, message
  // "Internal error", the real quota/reset text only in `.data.message`. The ACP SDK client
  // reconstructs it identically via `new RequestError(code, message, data)` (jsonrpc.js), so
  // RequestError.internalError({ message }) reproduces the on-client object faithfully.
  const wall = RequestError.internalError({ message: "You've hit your usage limit. Resets in 2 hours 30 minutes." });
  assert.equal(wall.code, -32603);
  assert.equal(wall.message, "Internal error");
  const mapped = mapThrownError(wall, { label: "codex-agent", backendId: "codex" });
  assert.equal(mapped.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
  assert.equal(mapped.recoverable, false);
  assert.equal(mapped.resetHint, "Resets in 2 hours 30 minutes");
  assert.equal(mapped.agentLabel, "codex-agent");
  assert.match(mapped.message, /usage limit/i); // provider text surfaced, not just "Internal error"
});

test("codex-acp usageLimitExceeded RequestError with no reset time => PROVIDER_USAGE_LIMIT, resetHint undefined", () => {
  const wall = RequestError.internalError({ message: "You have exceeded your current quota." });
  const mapped = mapThrownError(wall, "codex-agent");
  assert.equal(mapped.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
  assert.equal(mapped.recoverable, false);
  assert.equal(mapped.resetHint, undefined);
});

test("provider text in RequestError .data.details also classifies (backend-generic, no codex special-casing)", () => {
  const wall = new RequestError(-32603, "Internal error", { details: "rate limit exceeded, resets at 5pm UTC" });
  const mapped = mapThrownError(wall);
  assert.equal(mapped.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
  assert.equal(mapped.recoverable, false);
  assert.equal(mapped.resetHint, "resets at 5pm UTC");
});

test("regression: plain-message provider wall (Claude path, no .data) still => PROVIDER_USAGE_LIMIT", () => {
  // Claude fails the active turn with the provider text directly on the Error message (no `.data`).
  const mapped = mapThrownError(new Error("Usage limit reached. Resets at 9:00 AM."), "claude-agent");
  assert.equal(mapped.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
  assert.equal(mapped.recoverable, false);
  assert.equal(mapped.resetHint, "Resets at 9:00 AM");
  assert.equal(mapped.message, "Usage limit reached. Resets at 9:00 AM.");
});

test("errorText folds RequestError .data text in for classification; leaves non-text data alone", () => {
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

test("AUTH_REQUIRED authContext carries advertised method ids/types/names + backendId only", () => {
  const mapped = mapThrownError(RequestError.authRequired(undefined, "login first"), {
    label: "auth-agent",
    backendId: "codex",
    authMethods: [
      { type: "env_var", id: "api-key", name: "API Key", vars: [] },
      { id: "chat-gpt", name: "ChatGPT" }, // no `type` => defaults to "agent"
      { type: "terminal", id: "claude-login", name: "Terminal Login" },
    ],
  });
  assert.equal(mapped.code, WorkflowErrorCode.AUTH_REQUIRED);
  assert.deepEqual(mapped.authContext, {
    backendId: "codex",
    methods: [
      { id: "api-key", type: "env_var", name: "API Key" },
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

test("various provider-wall phrasings all classify as PROVIDER_USAGE_LIMIT", () => {
  for (const msg of [
    "429 Too Many Requests",
    "You have exceeded your current quota",
    "rate limit exceeded",
    "insufficient_quota",
    "GoUsageLimitError: blocked",
  ]) {
    assert.equal(mapThrownError(new Error(msg)).code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, msg);
  }
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
