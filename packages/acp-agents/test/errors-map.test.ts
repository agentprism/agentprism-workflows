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
