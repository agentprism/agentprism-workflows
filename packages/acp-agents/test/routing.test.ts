import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import * as barrel from "../src/index.js";
import { CustomAcpBackend, resolveBackendRegistry, resolveModelRoute, selectBackend } from "../src/index.js";
import { asciiLowercase, assertNoModelConfigOption } from "../src/routing.js";

// src/routing.ts is a pure move out of runner.ts (the SDK-style AcpAgent shares it instead of
// copying it). These tests pin the route shape the runner never exposed (`modelSpec`), the two
// module-only helpers, and the seam: `selectBackend` stays a projection of `resolveModelRoute`.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function withDefaultBackend<T>(value: string | undefined, body: () => T): T {
  const prev = process.env.AGENTPRISM_DEFAULT_BACKEND;
  try {
    if (value === undefined) delete process.env.AGENTPRISM_DEFAULT_BACKEND;
    else process.env.AGENTPRISM_DEFAULT_BACKEND = value;
    return body();
  } finally {
    if (prev === undefined) delete process.env.AGENTPRISM_DEFAULT_BACKEND;
    else process.env.AGENTPRISM_DEFAULT_BACKEND = prev;
  }
}

test("resolveModelRoute strips only a routed first segment and keeps the rest verbatim", () => {
  withDefaultBackend(undefined, () => {
    assert.deepEqual(
      pick(resolveModelRoute("codex/gpt-5.6-sol")),
      { id: "codex", modelSpec: "gpt-5.6-sol" },
    );
    assert.deepEqual(
      pick(resolveModelRoute("opencode/zai/glm-5.2")),
      { id: "opencode", modelSpec: "zai/glm-5.2" },
      "only the FIRST slash separates the backend; nested provider paths survive untouched",
    );
    assert.deepEqual(pick(resolveModelRoute("claude/opus[1m]")), { id: "claude", modelSpec: "opus[1m]" });
    assert.deepEqual(pick(resolveModelRoute("CoDeX/x")), { id: "codex", modelSpec: "x" });
    assert.deepEqual(
      pick(resolveModelRoute("pi")),
      { id: "pi", modelSpec: undefined },
      "a backend-only spec selects no model",
    );
    assert.deepEqual(
      pick(resolveModelRoute("pi/")),
      { id: "pi", modelSpec: "" },
      "a trailing slash is an empty model value, not an absent one",
    );
    assert.deepEqual(
      pick(resolveModelRoute("openai/gpt-5.6-luna")),
      { id: "claude", modelSpec: "openai/gpt-5.6-luna" },
      "an unrouted spec goes to the default backend with the WHOLE spec kept",
    );
    assert.deepEqual(pick(resolveModelRoute("opus")), { id: "claude", modelSpec: "opus" });
    assert.deepEqual(pick(resolveModelRoute(undefined)), { id: "claude", modelSpec: undefined });
  });
});

test("resolveModelRoute: a registered custom name wins over a built-in and over the default", () => {
  const registry = resolveBackendRegistry({
    claude: { command: "shadow-claude" },
    browser: { command: "browser-acp", args: ["--headless"] },
  });
  withDefaultBackend(undefined, () => {
    const shadow = resolveModelRoute("claude/opus", registry);
    assert.ok(shadow.backend instanceof CustomAcpBackend, "the custom shadow replaces the built-in");
    assert.equal(shadow.backend.id, "claude");
    assert.equal(shadow.modelSpec, "opus");
    assert.equal(shadow.backend.poolKey?.startsWith("claude#"), true);

    const custom = resolveModelRoute("Browser/chromium", registry);
    assert.ok(custom.backend instanceof CustomAcpBackend);
    assert.equal(custom.backend.id, "browser");
    assert.equal(custom.modelSpec, "chromium");

    assert.equal(resolveModelRoute("codex/x", registry).backend instanceof CustomAcpBackend, false);
  });
  withDefaultBackend("browser", () => {
    const route = resolveModelRoute("unknownish", registry);
    assert.ok(route.backend instanceof CustomAcpBackend, "a custom default backend is honored");
    assert.equal(route.backend.id, "browser");
    assert.equal(route.modelSpec, "unknownish");
    assert.equal(resolveModelRoute(undefined, registry).backend.id, "browser");
    // Without the registry the same env value is unknown and falls back to claude.
    assert.equal(resolveModelRoute(undefined).backend.id, "claude");
  });
  withDefaultBackend("PI", () => {
    assert.equal(resolveModelRoute("anthropic/claude-opus", registry).backend.id, "pi");
  });
});

test("selectBackend is exactly the backend half of resolveModelRoute (model wins over tier)", () => {
  withDefaultBackend(undefined, () => {
    for (const opts of [
      { model: "codex/x" },
      { tier: "pi/y" },
      { model: "mystery", tier: "codex/x" },
      { model: "OpenCode/zai/glm" },
      {},
    ] as const) {
      assert.equal(
        selectBackend(opts).id,
        resolveModelRoute(("model" in opts ? opts.model : undefined) ?? ("tier" in opts ? opts.tier : undefined)).backend.id,
      );
    }
  });
  const runner = readFileSync(resolve(root, "packages/acp-agents/src/runner.ts"), "utf8");
  assert.match(
    runner,
    /export function selectBackend\([\s\S]*?\{\n\s*return resolveModelRoute\(opts\.model \?\? opts\.tier, registry\)\.backend;\n\}/,
  );
});

test("asciiLowercase folds only A-Z (locale-independent, non-ASCII untouched)", () => {
  assert.equal(asciiLowercase("CoDeX"), "codex");
  assert.equal(asciiLowercase("already-lower_9"), "already-lower_9");
  assert.equal(asciiLowercase("İ-Ω-É"), "İ-Ω-É");
  assert.equal(asciiLowercase(""), "");
  // The routing grammar is the ASCII fold: a non-ASCII-uppercased name does not route.
  assert.equal(resolveModelRoute("ＣＬＡＵＤＥ/opus").modelSpec, "ＣＬＡＵＤＥ/opus");
});

test("assertNoModelConfigOption rejects the reserved `model` id as a labelled validation error", () => {
  assert.doesNotThrow(() => assertNoModelConfigOption(undefined, "a"));
  assert.doesNotThrow(() => assertNoModelConfigOption({}, undefined));
  assert.doesNotThrow(() => assertNoModelConfigOption({ thought_level: "high", verbose: true }, "a"));
  assert.throws(
    () => assertNoModelConfigOption({ model: "opus" }, "reviewer"),
    (error: unknown) =>
      isWorkflowError(error) &&
      error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
      error.recoverable === false &&
      error.agentLabel === "reviewer" &&
      error.message ===
        'Agent call "reviewer" configOptions must not contain reserved option id "model"; use the model field instead',
  );
  assert.throws(
    () => assertNoModelConfigOption({ model: false }, undefined),
    (error: unknown) =>
      isWorkflowError(error) &&
      error.agentLabel === undefined &&
      error.message.startsWith("Agent call configOptions must not contain"),
  );
});

test("barrel surface: resolveModelRoute is public; the module-only helpers are not", () => {
  assert.equal(typeof barrel.resolveModelRoute, "function");
  assert.equal(typeof barrel.selectBackend, "function");
  for (const name of ["asciiLowercase", "assertNoModelConfigOption", "defaultBackend", "sessionRefFor"]) {
    assert.equal(name in barrel, false, `${name} must stay a module export, not a package export`);
  }
  const index = readFileSync(resolve(root, "packages/acp-agents/src/index.ts"), "utf8");
  assert.match(index, /export \{ resolveModelRoute \} from "\.\/routing\.js";/);
  assert.match(index, /export type \{ ModelRoute \} from "\.\/routing\.js";/);
  assert.doesNotMatch(index, /session-ref\.js/);
});

function pick(route: { backend: { id: string }; modelSpec: string | undefined }) {
  return { id: route.backend.id, modelSpec: route.modelSpec };
}
