import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Type } from "typebox";
import { META_KEYS } from "@automatalabs/shared-types";
import { PiBackend } from "../src/index.js";
import type { StructuredSource } from "../src/index.js";

const require = createRequire(import.meta.url);
const SCHEMA = Type.Object({ city: Type.String({ minLength: 1 }), hot: Type.Boolean() });
const ENV_KEYS = ["AGENTPRISM_PI_ACP_CMD", "AGENTPRISM_PI_ACP_ARGS"] as const;

function source(text: string, finalText = text): StructuredSource {
  return { currentTurnText: () => text, finalMessageText: () => finalText, rawStructuredOutput: () => undefined };
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("PiBackend exposes the native pi structured-output posture", () => {
  const backend = new PiBackend();
  assert.equal(backend.id, "pi");
  assert.equal(backend.stripsRoutingPrefix, true);
  assert.equal(backend.embedSchemaInPrompt, false);
  assert.equal(backend.injectStructuredOutputTool, false);
  assert.deepEqual(backend.customCapabilities, {
    namespace: "@automatalabs/pi-acp",
    gatedKeys: [META_KEYS.outputSchema],
  });
});

test("PiBackend.spawnConfig: CMD override wins and argv comes only from _ARGS", () => {
  withEnv({ AGENTPRISM_PI_ACP_CMD: "/custom/pi-acp", AGENTPRISM_PI_ACP_ARGS: "--stdio  --x y" }, () => {
    const config = new PiBackend().spawnConfig();
    assert.equal(config.command, "/custom/pi-acp");
    assert.deepEqual(config.args, ["--stdio", "--x", "y"]);
    assert.equal(config.env, process.env);
  });
});

test("PiBackend.spawnConfig: CMD with no _ARGS yields an empty argv", () => {
  withEnv({ AGENTPRISM_PI_ACP_CMD: "/custom/pi-acp" }, () => {
    assert.deepEqual(new PiBackend().spawnConfig().args, []);
  });
});

test("PiBackend.spawnConfig: default resolves the package bin under the current Node", () => {
  withEnv({ AGENTPRISM_PI_ACP_ARGS: "--ignored-without-cmd" }, () => {
    const library = require.resolve("@automatalabs/pi-acp");
    const config = new PiBackend().spawnConfig();
    assert.equal(config.command, process.execPath);
    assert.deepEqual(config.args, [join(dirname(library), "index.js")]);
    assert.equal(config.env, process.env);
  });
});

test("PiBackend sends plain JSON Schema on the turn and parses only the final message", () => {
  const backend = new PiBackend();
  assert.equal(backend.sessionMeta(SCHEMA), undefined);
  assert.equal(backend.promptMeta(undefined), undefined);
  const meta = backend.promptMeta(SCHEMA) as Record<string, Record<string, unknown>>;
  assert.equal((meta[META_KEYS.outputSchema].properties as Record<string, Record<string, unknown>>).city.minLength, 1);
  assert.equal("additionalProperties" in meta[META_KEYS.outputSchema], false);

  const progress = '{"city":"progress","hot":false}';
  const final = '{"city":"Oslo","hot":true}';
  assert.deepEqual(backend.nativeStructured(source(progress + final, final)), { city: "Oslo", hot: true });
  assert.equal(backend.nativeStructured(source("not json")), undefined);
});

test("PiBackend classifies only categorical rate/billing walls as provider usage limits", () => {
  const backend = new PiBackend();
  for (const errorKind of ["rate_limit", "billing_error"] as const) {
    assert.deepEqual(
      backend.classifyProviderError?.({ data: { errorKind } }, { resetAt: "2026-07-16T12:00:00.000Z" }),
      {
        kind: "provider_usage_limit",
        context: {
          backendId: "pi",
          source: "provider",
          providerCode: errorKind,
          resetAt: "2026-07-16T12:00:00.000Z",
        },
      },
    );
  }
  assert.equal(backend.classifyProviderError?.({ data: { errorKind: "auth_error" } }), undefined);
  assert.equal(backend.classifyProviderError?.({ data: { errorKind: "provider_error" } }), undefined);
  assert.equal(backend.classifyProviderError?.(new Error("rate limit")), undefined);
});
