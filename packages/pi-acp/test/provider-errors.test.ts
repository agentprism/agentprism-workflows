import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { classifyPreflight, classifyTerminal } from "../src/errors.js";
import {
  FIXTURE_PI_PIN,
  NO_API_KEY_GUIDANCE,
  NO_MODEL_GUIDANCE,
  OAUTH_PROMPT_PREFLIGHT,
  OAUTH_REQUEST_AUTH,
  PROVIDER_ERROR_FIXTURES,
} from "./fixtures/provider-error-strings.js";

function kind(error: ReturnType<typeof classifyPreflight | typeof classifyTerminal>): unknown {
  return (error.data as { errorKind?: unknown } | undefined)?.errorKind;
}

test("E1 pinned provider prose retains auth > billing > rate > generic classification", () => {
  assert.equal(kind(classifyPreflight(new Error(NO_MODEL_GUIDANCE))), "invalid_model");
  assert.equal(kind(classifyPreflight(new Error(NO_API_KEY_GUIDANCE))), "auth_error");
  assert.equal(kind(classifyPreflight(new Error(OAUTH_REQUEST_AUTH))), "auth_error");
  assert.equal(kind(classifyPreflight(new Error(OAUTH_PROMPT_PREFLIGHT))), "auth_error");
  for (const fixture of PROVIDER_ERROR_FIXTURES) {
    assert.equal(kind(classifyTerminal({ stopReason: "error", errorMessage: fixture.value })), fixture.kind, fixture.value);
  }
});

test("E1 normalized upstream guidance templates byte-equal the captured fixtures", () => {
  const help = [
    "Use /login to log into a provider via OAuth or API key. See:",
    "  <DOCS>/providers.md",
    "  <DOCS>/models.md",
  ].join("\n");
  assert.equal(NO_MODEL_GUIDANCE, `No model selected.\n\n${help}\n\nThen use /model to select a model.`);
  assert.equal(NO_API_KEY_GUIDANCE, `No API key found for anthropic.\n\n${help}`);
  assert.equal(OAUTH_REQUEST_AUTH, OAUTH_PROMPT_PREFLIGHT);
});

test("E2 classifier fixture pin equals the installed pi runtime", () => {
  const require = createRequire(import.meta.url);
  let entry: string;
  try {
    entry = require.resolve("@earendil-works/pi-coding-agent");
  } catch {
    entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  }
  const manifest = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as { version: string };
  assert.equal(FIXTURE_PI_PIN, manifest.version);
});
