import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { PiBackend } from "../src/index.js";

const require = createRequire(import.meta.url);
const ENV_KEYS = ["AGENTPRISM_PI_ACP_CMD", "AGENTPRISM_PI_ACP_ARGS"] as const;

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

test("PiBackend exposes the standard injected structured-output posture", () => {
  const backend = new PiBackend();
  assert.equal(backend.id, "pi");
  assert.equal(backend.embedSchemaInPrompt, true);
  assert.equal(backend.injectStructuredOutputTool, true);
  assert.equal(backend.customCapabilities, undefined);
  assert.equal(backend.nativeStructured, undefined);
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

test("PiBackend sends no private prompt metadata and has no native result hook", () => {
  const backend = new PiBackend();
  assert.equal(backend.sessionMeta(undefined), undefined);
  assert.equal(backend.promptMeta(undefined), undefined);
  assert.equal(backend.promptMeta({ type: "object" } as never), undefined);
  assert.equal(backend.nativeStructured, undefined);
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
