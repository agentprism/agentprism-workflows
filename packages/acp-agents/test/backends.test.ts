// Areas (2a)/(3a): the Backend strategy seam — how each backend carries the schema IN
// (Claude: session/new _meta.claudeCode; Codex: per-turn _meta["outputSchema"])
// and reads the native structured result OUT — plus selectBackend cross-provider routing.
import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { META_KEYS } from "@automatalabs/shared-types";
import { ClaudeBackend, CodexBackend, OpenCodeBackend, PiBackend, selectBackend, toStrictJsonSchema } from "../src/index.js";
import type { Backend, StructuredSource } from "../src/index.js";

const SCHEMA = Type.Object({ city: Type.String({ minLength: 1 }), hot: Type.Boolean() });

function source(text: string, raw: unknown, finalText = text): StructuredSource {
  return { currentTurnText: () => text, finalMessageText: () => finalText, rawStructuredOutput: () => raw };
}

// ---- Claude backend -----------------------------------------------------------------

test("ClaudeBackend.sessionMeta carries outputFormat + emitRawSDKMessages at session/new", () => {
  const meta = new ClaudeBackend().sessionMeta(SCHEMA) as {
    claudeCode: { options: { outputFormat: { type: string; schema: Record<string, unknown> } }; emitRawSDKMessages: boolean };
  };
  assert.equal(meta.claudeCode.options.outputFormat.type, "json_schema");
  assert.equal(meta.claudeCode.emitRawSDKMessages, true);
  // Claude path is ANTHROPIC-normalized (not OpenAI-strict): additionalProperties:false is
  // REQUIRED on every object and unsupported validation keywords are stripped, but authored
  // `required` is preserved — Anthropic allows optional properties.
  const schema = meta.claudeCode.options.outputFormat.schema;
  assert.equal(schema.additionalProperties, false);
  assert.equal("minLength" in (schema.properties as Record<string, Record<string, unknown>>).city, false);
  assert.deepEqual(schema.required, ["city", "hot"]);
});

test("ClaudeBackend: no schema => no session _meta; never carries schema on the turn", () => {
  // Typed through the Backend seam (the engine only ever sees Backend), so promptMeta takes
  // the schema arg even though Claude deliberately ignores it.
  const backend: Backend = new ClaudeBackend();
  assert.equal(backend.sessionMeta(undefined), undefined);
  assert.equal(backend.promptMeta(SCHEMA), undefined); // Claude schema is session-scoped, not per-turn
  assert.equal(backend.id, "claude");
});

test("ClaudeBackend.nativeStructured reads structured_output off the raw SDK result", () => {
  const backend = new ClaudeBackend();
  assert.deepEqual(backend.nativeStructured(source("ignored prose", { city: "NYC", hot: true })), {
    city: "NYC",
    hot: true,
  });
  // no raw message captured => undefined (the ladder then falls back to prose extraction)
  assert.equal(backend.nativeStructured(source("text", undefined)), undefined);
});

// ---- Codex backend ------------------------------------------------------------------

test("CodexBackend.promptMeta forwards the STRICT schema under the bare outputSchema key", () => {
  const backend = new CodexBackend();
  const meta = backend.promptMeta(SCHEMA) as Record<string, unknown>;
  assert.deepEqual(meta, { [META_KEYS.outputSchema]: toStrictJsonSchema(SCHEMA) });
  // sanity: the key is bare (un-namespaced), and the schema really is strict-normalized
  assert.equal(META_KEYS.outputSchema, "outputSchema");
  const strict = meta[META_KEYS.outputSchema] as Record<string, unknown>;
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.required, ["city", "hot"]);
  assert.equal("minLength" in (strict.properties as Record<string, Record<string, unknown>>).city, false);
});

test("CodexBackend: no schema => no prompt _meta; never carries schema at session/new", () => {
  const backend: Backend = new CodexBackend();
  assert.equal(backend.promptMeta(undefined), undefined);
  assert.equal(backend.sessionMeta(SCHEMA), undefined); // Codex carries the schema on the turn, not session/new
  assert.equal(backend.id, "codex");
});

test("CodexBackend.sessionMeta emits base/developer instructions as BARE session/new _meta keys", () => {
  const backend: Backend = new CodexBackend();
  // No inputs (or empty inputs) => nothing at session/new; the schema still rides the turn.
  assert.equal(backend.sessionMeta(SCHEMA), undefined);
  assert.equal(backend.sessionMeta(undefined, {}), undefined);
  // Both present => bare keys the codex-acp fork reads.
  assert.deepEqual(backend.sessionMeta(SCHEMA, { baseInstructions: "BASE", developerInstructions: "DEV" }), {
    baseInstructions: "BASE",
    developerInstructions: "DEV",
  });
  // Only the provided key is emitted (each is independently optional).
  assert.deepEqual(backend.sessionMeta(undefined, { baseInstructions: "BASE" }), { baseInstructions: "BASE" });
  assert.deepEqual(backend.sessionMeta(undefined, { developerInstructions: "DEV" }), { developerInstructions: "DEV" });
});

test("ClaudeBackend.sessionMeta ignores Codex session instruction inputs", () => {
  const backend: Backend = new ClaudeBackend();
  // Instructions are Codex-only: with no schema Claude sends no _meta despite the inputs...
  assert.equal(backend.sessionMeta(undefined, { baseInstructions: "BASE", developerInstructions: "DEV" }), undefined);
  // ...and with a schema, the claudeCode channel is untouched — no instruction keys leak in.
  const meta = backend.sessionMeta(SCHEMA, { baseInstructions: "BASE" }) as Record<string, unknown>;
  assert.ok(meta.claudeCode, "schema channel preserved");
  assert.equal("baseInstructions" in meta, false);
  assert.equal("developerInstructions" in meta, false);
});

test("CodexBackend.nativeStructured parses the constrained final message (pure JSON, then block)", () => {
  const backend = new CodexBackend();
  // pure JSON final message
  assert.deepEqual(backend.nativeStructured(source('{"city":"LA","hot":false}', undefined)), {
    city: "LA",
    hot: false,
  });
  // leading prose + fenced block => balanced-block extraction
  assert.deepEqual(
    backend.nativeStructured(source('Here:\n```json\n{"city":"SF","hot":true}\n```', undefined)),
    { city: "SF", hot: true },
  );
  // empty turn => undefined
  assert.equal(backend.nativeStructured(source("   ", undefined)), undefined);
});

test("CodexBackend.nativeStructured reads ONLY the final message — a schema-shaped progress message never wins", () => {
  const backend = new CodexBackend();
  // Codex's turn-wide constraint makes intermediate progress messages schema-shaped too. The
  // whole-turn concatenation starts with the progress object; extraction must read the final
  // message, never scan the turn for the first balanced JSON block.
  const progress = '{"city":"progress-not-result","hot":false}';
  const final = '{"city":"LA","hot":true}';
  assert.deepEqual(backend.nativeStructured(source(progress + final, undefined, final)), {
    city: "LA",
    hot: true,
  });
  // turn ended on a tool call (no trailing message) => undefined, so the ladder re-prompts
  // instead of resurrecting a progress object from earlier in the turn.
  assert.equal(backend.nativeStructured(source(progress, undefined, "")), undefined);
});

// ---- OpenCode backend ---------------------------------------------------------------

test("OpenCodeBackend is the third built-in backend", () => {
  const backend: Backend = new OpenCodeBackend();
  assert.equal(backend.id, "opencode");
  assert.equal(backend.embedSchemaInPrompt, true);
  assert.equal(backend.injectStructuredOutputTool, true);
});

// ---- selectBackend cross-provider routing -------------------------------------------

test("PiBackend is the fourth built-in backend", () => {
  const backend: Backend = new PiBackend();
  assert.equal(backend.id, "pi");
});

test("selectBackend routes only by a registered first segment", () => {
  assert.equal(selectBackend({ model: "codex/whatever" }).id, "codex");
  assert.equal(selectBackend({ model: "opencode" }).id, "opencode");
  assert.equal(selectBackend({ model: "opencode/zai/glm-5.2" }).id, "opencode");
  assert.equal(selectBackend({ model: "pi/openrouter/anthropic/claude-sonnet" }).id, "pi");
  assert.equal(selectBackend({ model: "claude/sonnet" }).id, "claude");
  assert.equal(selectBackend({ model: "CoDeX/gpt-5.6-luna" }).id, "codex");
  // Aliases and bare family names are unregistered, so they use the default (Claude here).
  assert.equal(selectBackend({ model: "openai/gpt-5.6-luna" }).id, "claude");
  assert.equal(selectBackend({ model: "gpt-5.6-luna" }).id, "claude");
  assert.equal(selectBackend({ model: "o3-mini" }).id, "claude");
  assert.equal(selectBackend({ model: "glm-5.2" }).id, "claude");
  assert.equal(selectBackend({ model: "claude-3-5-sonnet" }).id, "claude");
  assert.equal(selectBackend({ model: "opus" }).id, "claude");
});

test("selectBackend: model is the effective spec when present; otherwise tier is used", () => {
  assert.equal(selectBackend({ model: "mystery-model", tier: "codex/gpt" }).id, "claude");
  assert.equal(selectBackend({ tier: "codex/gpt" }).id, "codex");
  assert.equal(selectBackend({ model: "mystery-model" }).id, "claude");
  assert.equal(selectBackend({}).id, "claude");
});

test("selectBackend honors AGENTPRISM_DEFAULT_BACKEND when nothing else matches", () => {
  const prev = process.env.AGENTPRISM_DEFAULT_BACKEND;
  try {
    process.env.AGENTPRISM_DEFAULT_BACKEND = "codex";
    assert.equal(selectBackend({}).id, "codex");
    assert.equal(selectBackend({ model: "unknownish" }).id, "codex");
    process.env.AGENTPRISM_DEFAULT_BACKEND = "opencode";
    assert.equal(selectBackend({}).id, "opencode");
    assert.equal(selectBackend({ model: "unknownish" }).id, "opencode");
    assert.equal(selectBackend({ model: "anthropic/claude-opus" }).id, "opencode");
    assert.equal(selectBackend({ model: "claude/claude-opus" }).id, "claude");
    process.env.AGENTPRISM_DEFAULT_BACKEND = "pi";
    assert.equal(selectBackend({}).id, "pi");
    assert.equal(selectBackend({ model: "openrouter/vendor/model" }).id, "pi");
    process.env.AGENTPRISM_DEFAULT_BACKEND = "CoDeX";
    assert.equal(selectBackend({}).id, "codex");
    process.env.AGENTPRISM_DEFAULT_BACKEND = "";
    assert.equal(selectBackend({}).id, "claude");
    process.env.AGENTPRISM_DEFAULT_BACKEND = "unknown";
    assert.equal(selectBackend({}).id, "claude");
  } finally {
    if (prev === undefined) delete process.env.AGENTPRISM_DEFAULT_BACKEND;
    else process.env.AGENTPRISM_DEFAULT_BACKEND = prev;
  }
});
