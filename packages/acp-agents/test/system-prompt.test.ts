// `assertSystemPromptSupported`: the one pre-open validator for the backend-neutral `systemPrompt`
// instructions — shape, normalization, and the per-backend refusal (an unsupported field is a
// SCRIPT_VALIDATION_ERROR naming the backend, never a silent drop).
import test from "node:test";
import assert from "node:assert/strict";
import { isWorkflowError, WorkflowErrorCode, type SystemPromptOptions } from "@automatalabs/shared-types";
import {
  ClaudeBackend,
  CodexBackend,
  CustomAcpBackend,
  OpenCodeBackend,
  PiBackend,
  assertSystemPromptSupported,
  describeSystemPromptSupport,
} from "../src/index.js";

function validation(pattern: RegExp, label?: string) {
  return (error: unknown): boolean => {
    assert.ok(isWorkflowError(error), `expected a WorkflowError, got ${String(error)}`);
    assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
    assert.equal(error.recoverable, false);
    assert.equal(error.agentLabel, label);
    assert.match(error.message, pattern);
    return true;
  };
}

test("undefined and empty instructions normalize to undefined on every backend", () => {
  for (const backend of [new ClaudeBackend(), new CodexBackend(), new PiBackend(), new OpenCodeBackend()]) {
    assert.equal(assertSystemPromptSupported(backend, undefined, undefined), undefined);
    assert.equal(assertSystemPromptSupported(backend, {}, undefined), undefined);
    assert.equal(assertSystemPromptSupported(backend, { replace: undefined, append: undefined }, undefined), undefined);
  }
});

test("a supported request is returned with only its defined fields", () => {
  assert.deepEqual(assertSystemPromptSupported(new CodexBackend(), { replace: "R", append: undefined }, "x"), { replace: "R" });
  assert.deepEqual(assertSystemPromptSupported(new ClaudeBackend(), { append: "A" }, "x"), { append: "A" });
  assert.deepEqual(assertSystemPromptSupported(new PiBackend(), { replace: "R", append: "A" }, "x"), { replace: "R", append: "A" });
});

test("shape errors: non-object, unknown field, non-string or blank field", () => {
  const backend = new ClaudeBackend();
  assert.throws(
    () => assertSystemPromptSupported(backend, "be terse" as unknown as SystemPromptOptions, "lbl"),
    validation(/Agent call "lbl" systemPrompt must be an object/, "lbl"),
  );
  assert.throws(
    () => assertSystemPromptSupported(backend, { base: "x" } as unknown as SystemPromptOptions, undefined),
    validation(/systemPrompt has unknown field "base"; only replace \/ append are accepted/),
  );
  assert.throws(
    () => assertSystemPromptSupported(backend, { replace: "" }, undefined),
    validation(/systemPrompt\.replace must be a non-empty string/),
  );
  assert.throws(
    () => assertSystemPromptSupported(backend, { append: "   " }, undefined),
    validation(/systemPrompt\.append must be a non-empty string/),
  );
  assert.throws(
    () => assertSystemPromptSupported(backend, { append: 42 as unknown as string }, undefined),
    validation(/systemPrompt\.append must be a non-empty string/),
  );
});

test("a backend without the channel refuses both fields and points at its own configuration / meta", () => {
  const opencode = new OpenCodeBackend();
  assert.throws(
    () => assertSystemPromptSupported(opencode, { replace: "R" }, "oc"),
    validation(/systemPrompt\.replace is not supported by backend "opencode" \(supported: none\); this backend exposes no ACP system-prompt channel/, "oc"),
  );
  assert.throws(
    () => assertSystemPromptSupported(opencode, { replace: "R", append: "A" }, undefined),
    validation(/systemPrompt\.replace \/ append is not supported by backend "opencode"/),
  );
  const custom = new CustomAcpBackend({ name: "mine", command: "mine-acp" });
  assert.throws(
    () => assertSystemPromptSupported(custom, { append: "A" }, undefined),
    validation(/systemPrompt\.append is not supported by backend "mine" \(supported: none\)[^\n]*meta passthrough/),
  );
});

test("a partially supported row refuses only the missing half", () => {
  const appendOnly = { id: "append-only", systemPrompt: { replace: false, append: true } };
  assert.deepEqual(assertSystemPromptSupported(appendOnly, { append: "A" }, undefined), { append: "A" });
  assert.throws(
    () => assertSystemPromptSupported(appendOnly, { replace: "R", append: "A" }, undefined),
    validation(/systemPrompt\.replace is not supported by backend "append-only" \(supported: append only\); use a supported field/),
  );
});

test("describeSystemPromptSupport wording", () => {
  assert.equal(describeSystemPromptSupport({ replace: true, append: true }), "replace and append");
  assert.equal(describeSystemPromptSupport({ replace: true, append: false }), "replace only");
  assert.equal(describeSystemPromptSupport({ replace: false, append: true }), "append only");
  assert.equal(describeSystemPromptSupport({ replace: false, append: false }), "none");
});
