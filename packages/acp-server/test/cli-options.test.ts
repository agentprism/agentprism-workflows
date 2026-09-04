import assert from "node:assert/strict";
import test from "node:test";
import { parseCliOptions } from "../src/cli-options.js";

test("stdio requires transport-boundary endpoint selection", () => {
  assert.deepEqual(parseCliOptions(["--discovery"]), {
    mode: "stdio",
    endpoint: { kind: "discovery" },
  });
  assert.deepEqual(parseCliOptions(["--backend", "codex"]), {
    mode: "stdio",
    endpoint: { kind: "backend", backendId: "codex" },
  });
  assert.throws(() => parseCliOptions([]), /requires exactly one/);
  assert.throws(() => parseCliOptions(["--discovery", "--backend", "codex"]), /requires exactly one/);
});

test("HTTP owns the endpoint hierarchy and rejects the retired single-path interface", () => {
  assert.deepEqual(
    parseCliOptions(["--http", "--host=0.0.0.0", "--port", "7441", "--base-path", "/agents"]),
    { mode: "http", host: "0.0.0.0", port: 7441, basePath: "/agents" },
  );
  assert.throws(() => parseCliOptions(["--http", "--backend", "codex"]), /cannot be combined/);
  assert.throws(() => parseCliOptions(["--http", "--path", "/acp"]), /Unknown argument: --path/);
});
