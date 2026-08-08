// Classification of a resource-read failure (read-error.ts) — the decision the panel's onReadError
// and useSkeleton make instead of blindly feeding every fault to degrade(). The decisive case is
// HOST_NO_APP_RESOURCES: pi (and any host that never wired app-originated resources/read) answers
// the read with JSON-RPC -32601, and that must NEVER spin "reconnecting…"/"disconnected" — it is a
// permanent host property that switches the panel to the pi stream or the static fallback.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyReadError,
  METHOD_NOT_FOUND_CODE,
  readErrorCode,
} from "../ui/src/read-error.js";

/** The measured shape of pi's rejection: name "McpError", numeric code -32601, "Method not found". */
class McpErrorLike extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

test("the measured pi -32601 rejection classifies as host-no-app-resources (by code, not message)", () => {
  assert.equal(METHOD_NOT_FOUND_CODE, -32601);
  // Exactly what pi's real bundle returns for app.readServerResource of BOTH events URI forms.
  const measured = new McpErrorLike(-32601, "MCP error -32601: Method not found");
  assert.equal(classifyReadError(measured), "host-no-app-resources");
  // The message carries no matchable token, so classification MUST come from the code.
  assert.equal(readErrorCode(measured), -32601);
});

test("stream-generation faults classify as a rebuild", () => {
  assert.equal(classifyReadError(new Error("Workflow events ... failed (STREAM_MISMATCH).")), "stream-rebuild");
  assert.equal(classifyReadError(new Error("Workflow events ... failed (CURSOR_AHEAD).")), "stream-rebuild");
});

test("run-store-fatal tokens classify as run-not-found", () => {
  assert.equal(
    classifyReadError(new McpErrorLike(-32602, "Workflow events for r are unavailable (RUN_NOT_FOUND).")),
    "run-not-found",
  );
  assert.equal(classifyReadError(new Error("Workflow events ... failed (ORPHANED_LOG).")), "run-not-found");
  assert.equal(classifyReadError(new Error("No workflow run found for runId \"x\".")), "run-not-found");
});

test("run-not-found tokens win even when the code is -32601 (message specificity first)", () => {
  // Defensive ordering: our own RUN_NOT_FOUND token routes to the fatal path regardless of the code.
  const both = new McpErrorLike(-32601, "unavailable (RUN_NOT_FOUND)");
  assert.equal(classifyReadError(both), "run-not-found");
});

test("everything else is transient — a genuine fault on a host where reads can succeed", () => {
  assert.equal(classifyReadError(new McpErrorLike(-32603, "MCP error -32603: Internal error")), "transient");
  assert.equal(classifyReadError(new Error("network blip")), "transient");
  assert.equal(classifyReadError("string fault"), "transient");
  assert.equal(classifyReadError(undefined), "transient");
});

test("readErrorCode extracts numeric codes and ignores non-numeric/absent ones", () => {
  assert.equal(readErrorCode(new McpErrorLike(-32601, "x")), -32601);
  assert.equal(readErrorCode({ code: "not-a-number" }), undefined);
  assert.equal(readErrorCode(new Error("no code")), undefined);
  assert.equal(readErrorCode(null), undefined);
});
