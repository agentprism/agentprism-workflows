// Supports area (4): the client-side structured-output GUARD (validate-then-re-prompt ladder)
// and its primitives. The ladder is:
//   1. captured StructuredOutput tool args  2. native constraint
//   3. client-side validate (typebox Convert -> Check)
//   4. re-prompt up to maxSchemaRetries (strict prose extraction each turn)
//   5. exhausted -> SCHEMA_NONCOMPLIANCE (non-recoverable).
import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import {
  extractValidated,
  findJsonBlock,
  resolveStructuredOutput,
  validateValue,
  type StructuredSession,
} from "../src/index.js";

const SCHEMA = Type.Object({ city: Type.String(), hot: Type.Boolean() });

// ---- primitives ---------------------------------------------------------------------

test("findJsonBlock prefers a fenced ```json block", () => {
  assert.equal(findJsonBlock('prose\n```json\n{"a":1}\n```\nmore'), '{"a":1}');
  assert.equal(findJsonBlock("```\n[1,2,3]\n```"), "[1,2,3]");
});

test("findJsonBlock falls back to the first balanced object/array", () => {
  assert.equal(findJsonBlock('here {"a":{"b":2}} tail'), '{"a":{"b":2}}');
  assert.equal(findJsonBlock("x [1,[2],3] y"), "[1,[2],3]");
  assert.equal(findJsonBlock("no json here"), undefined);
});

test("validateValue coerces toward the schema then checks (typebox Convert -> Check)", () => {
  // Convert coerces the string "true" -> boolean true for the boolean field
  assert.deepEqual(validateValue({ city: "NYC", hot: "true" }, SCHEMA), { city: "NYC", hot: true });
  // genuinely wrong shape => undefined (never fabricates)
  assert.equal(validateValue({ city: "NYC" }, SCHEMA), undefined);
  assert.equal(validateValue("not an object", SCHEMA), undefined);
});

test("extractValidated pulls JSON from prose and only accepts it if it validates", () => {
  assert.deepEqual(extractValidated('Result:\n```json\n{"city":"LA","hot":false}\n```', SCHEMA), {
    city: "LA",
    hot: false,
  });
  // present JSON that does not satisfy the schema => undefined
  assert.equal(extractValidated('{"city":"LA"}', SCHEMA), undefined);
  // unparseable / absent => undefined
  assert.equal(extractValidated("totally freeform text", SCHEMA), undefined);
});

// ---- ladder -------------------------------------------------------------------------

/** A scriptable StructuredSession double: each prompt() advances to the next scripted turn. */
function scriptedSession(turns: Array<{ text?: string; native?: unknown; captured?: unknown }>): StructuredSession & {
  promptCount: number;
  prompts: string[];
} {
  let index = 0;
  const current = () => turns[Math.min(index, turns.length - 1)] ?? {};
  return {
    promptCount: 0,
    prompts: [],
    async prompt(text: string) {
      this.promptCount += 1;
      this.prompts.push(text);
      index += 1;
    },
    lastText: () => current().text ?? "",
    tryCaptured: () => current().captured,
    tryNative: () => current().native,
  };
}

test("ladder: captured StructuredOutput args win before native and text", async () => {
  const session = scriptedSession([
    {
      captured: { city: "Oslo", hot: false },
      native: { city: "NYC", hot: true },
      text: '{"city":"LA","hot":true}',
    },
  ]);
  const out = await resolveStructuredOutput(session, SCHEMA, { maxSchemaRetries: 2 });
  assert.deepEqual(out, { city: "Oslo", hot: false });
  assert.equal(session.promptCount, 0);
});

test("ladder: native constraint hit on the first turn (no re-prompts)", async () => {
  const session = scriptedSession([{ native: { city: "NYC", hot: true } }]);
  const out = await resolveStructuredOutput(session, SCHEMA, { maxSchemaRetries: 2 });
  assert.deepEqual(out, { city: "NYC", hot: true });
  assert.equal(session.promptCount, 0); // resolved without re-prompting
});

test("ladder: prose extraction when there is no native result", async () => {
  const session = scriptedSession([{ text: 'Final:\n```json\n{"city":"SF","hot":false}\n```' }]);
  const out = await resolveStructuredOutput(session, SCHEMA, { maxSchemaRetries: 2 });
  assert.deepEqual(out, { city: "SF", hot: false });
  assert.equal(session.promptCount, 0);
});

test("ladder: invalid native is rejected, then a later re-prompt turn succeeds", async () => {
  const session = scriptedSession([
    { native: { city: "NYC" }, text: "no json" }, // invalid native + no extractable prose
    { native: { city: "NYC", hot: true } }, // first re-prompt yields a valid native
  ]);
  const out = await resolveStructuredOutput(session, SCHEMA, { maxSchemaRetries: 2 });
  assert.deepEqual(out, { city: "NYC", hot: true });
  assert.equal(session.promptCount, 1); // exactly one repair turn used
});

test("ladder: custom repair text is used when provided", async () => {
  const session = scriptedSession([
    { text: "plain" },
    { captured: { city: "Oslo", hot: false } },
  ]);
  const out = await resolveStructuredOutput(session, SCHEMA, {
    maxSchemaRetries: 2,
    repromptText: "call the StructuredOutput tool",
  });
  assert.deepEqual(out, { city: "Oslo", hot: false });
  assert.deepEqual(session.prompts, ["call the StructuredOutput tool"]);
});

test("ladder: exhausted after maxSchemaRetries => SCHEMA_NONCOMPLIANCE (non-recoverable)", async () => {
  const session = scriptedSession([{ text: "never any json" }]);
  await assert.rejects(
    () => resolveStructuredOutput(session, SCHEMA, { maxSchemaRetries: 2, label: "lbl" }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
      assert.equal(err.recoverable, false);
      assert.equal(err.agentLabel, "lbl");
      return true;
    },
  );
  assert.equal(session.promptCount, 2); // exactly maxSchemaRetries repair turns attempted
});

test("ladder: maxSchemaRetries defaults to 2 and clamps negatives to 0", async () => {
  const def = scriptedSession([{ text: "no json" }]);
  await assert.rejects(() => resolveStructuredOutput(def, SCHEMA, {}));
  assert.equal(def.promptCount, 2); // default

  const none = scriptedSession([{ text: "no json" }]);
  await assert.rejects(() => resolveStructuredOutput(none, SCHEMA, { maxSchemaRetries: -5 }));
  assert.equal(none.promptCount, 0); // clamped to 0 -> no repair turns
});

test("ladder: an already-aborted signal throws before any re-prompt", async () => {
  const session = scriptedSession([{ text: "no json" }]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => resolveStructuredOutput(session, SCHEMA, { maxSchemaRetries: 3, signal: controller.signal }),
    (err: unknown) => err instanceof Error && !isWorkflowError(err), // raw abort, not a seam error
  );
  assert.equal(session.promptCount, 0);
});
