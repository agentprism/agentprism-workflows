import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { META_KEYS } from "@automatalabs/shared-types";
import { OpenCodeBackend } from "../src/index.js";
import type { StructuredSource } from "../src/index.js";

const SCHEMA = Type.Object({ city: Type.String({ minLength: 1 }), hot: Type.Boolean() });
const ENV_KEYS = ["AGENTPRISM_OPENCODE_ACP_CMD", "AGENTPRISM_OPENCODE_ACP_ARGS"] as const;

function source(text: string, finalText = text): StructuredSource {
  return { currentTurnText: () => text, finalMessageText: () => finalText, rawStructuredOutput: () => undefined };
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) prev[key] = process.env[key];
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test("OpenCodeBackend exposes its id and generic structured-output flags", () => {
  const backend = new OpenCodeBackend();
  assert.equal(backend.id, "opencode");
  assert.equal(backend.embedSchemaInPrompt, true);
  assert.equal(backend.injectStructuredOutputTool, true);
});

test("OpenCodeBackend.spawnConfig: CMD override wins and argv comes only from _ARGS", () => {
  withEnv({ AGENTPRISM_OPENCODE_ACP_CMD: "/custom/opencode", AGENTPRISM_OPENCODE_ACP_ARGS: "--stdio  --x y" }, () => {
    const cfg = new OpenCodeBackend().spawnConfig();
    assert.equal(cfg.command, "/custom/opencode");
    assert.deepEqual(cfg.args, ["--stdio", "--x", "y"]);
    assert.equal(cfg.env, process.env);
  });
});

test("OpenCodeBackend.spawnConfig: CMD with no _ARGS yields an empty argv", () => {
  withEnv({ AGENTPRISM_OPENCODE_ACP_CMD: "/custom/opencode" }, () => {
    const cfg = new OpenCodeBackend().spawnConfig();
    assert.equal(cfg.command, "/custom/opencode");
    assert.deepEqual(cfg.args, []);
  });
});

test("OpenCodeBackend.spawnConfig: default falls back to opencode acp on PATH", () => {
  withEnv({ AGENTPRISM_OPENCODE_ACP_ARGS: "--ignored-without-cmd" }, () => {
    const cfg = new OpenCodeBackend().spawnConfig();
    assert.equal(cfg.command, "opencode");
    assert.deepEqual(cfg.args, ["acp"]);
    assert.equal(cfg.env, process.env);
  });
});

test("OpenCodeBackend: schema uses generic prompt _meta; session _meta is empty", () => {
  const backend = new OpenCodeBackend();
  assert.equal(backend.sessionMeta(SCHEMA), undefined);
  assert.equal(backend.promptMeta(undefined), undefined);

  const meta = backend.promptMeta(SCHEMA) as Record<string, Record<string, unknown>>;
  const schema = meta[META_KEYS.outputSchema];
  assert.ok(schema, "outputSchema forwarded on the turn");
  assert.equal((schema.properties as Record<string, Record<string, unknown>>).city.minLength, 1);
  assert.equal("additionalProperties" in schema, false);
});

test("OpenCodeBackend.nativeStructured parses final text JSON", () => {
  const backend = new OpenCodeBackend();
  assert.deepEqual(backend.nativeStructured(source('{"city":"LA","hot":false}')), {
    city: "LA",
    hot: false,
  });
  assert.deepEqual(backend.nativeStructured(source('Here:\n```json\n{"city":"SF","hot":true}\n```')), {
    city: "SF",
    hot: true,
  });
  assert.equal(backend.nativeStructured(source("no json")), undefined);
});
