// Focused run-option validation for first-turn image attachments. Invalid image options are
// script errors: deterministic, non-recoverable, and rejected before any ACP process is spawned.
import test from "node:test";
import assert from "node:assert/strict";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { AcpAgentRunner } from "../src/index.js";

test("runner: images validation rejects a missing data string and names the bad index", async () => {
  const runner = new AcpAgentRunner();
  try {
    await assert.rejects(
      () => runner.run("hi", { images: [{ data: "", mimeType: "image/png" }], label: "image-agent" }),
      (err: unknown) => {
        assert.ok(isWorkflowError(err));
        assert.equal(err.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.equal(err.recoverable, false);
        assert.equal(err.agentLabel, "image-agent");
        assert.match(err.message, /images\[0\]\.data/);
        return true;
      },
    );
  } finally {
    await runner.dispose();
  }
});

test("runner: images validation rejects a missing mimeType string and names the bad index", async () => {
  const runner = new AcpAgentRunner();
  try {
    await assert.rejects(
      () =>
        runner.run("hi", {
          images: [
            { data: "ZmFrZQ==", mimeType: "image/png" },
            { data: "ZmFrZQ==", mimeType: " " },
          ],
        }),
      (err: unknown) => {
        assert.ok(isWorkflowError(err));
        assert.equal(err.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.equal(err.recoverable, false);
        assert.match(err.message, /images\[1\]\.mimeType/);
        return true;
      },
    );
  } finally {
    await runner.dispose();
  }
});
