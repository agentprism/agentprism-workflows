import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The shared seam owns the WorkflowError runtime class, structured contexts, and guards.
import {
  isAuthRequired,
  isProviderUsageLimit,
  WorkflowError,
  WorkflowErrorCode,
  type AuthErrorContext,
  type CheckpointContext,
  type ProviderUsageLimitContext,
  type WorkflowRecordedError,
} from "../src/errors.js";

describe("isProviderUsageLimit", () => {
  it("is true only for a PROVIDER_USAGE_LIMIT WorkflowError", () => {
    assert.equal(
      isProviderUsageLimit(
        new WorkflowError("x", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false }),
      ),
      true,
    );
    assert.equal(isProviderUsageLimit(new WorkflowError("x", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE)), false);
    assert.equal(isProviderUsageLimit(new Error("usage limit")), false);
    assert.equal(isProviderUsageLimit(undefined), false);
    assert.equal(isProviderUsageLimit("usage limit"), false);
  });
});

describe("isAuthRequired", () => {
  it("is true only for an AUTH_REQUIRED WorkflowError", () => {
    assert.equal(
      isAuthRequired(new WorkflowError("x", WorkflowErrorCode.AUTH_REQUIRED, { recoverable: false })),
      true,
    );
    assert.equal(isAuthRequired(new WorkflowError("x", WorkflowErrorCode.PROVIDER_USAGE_LIMIT)), false);
    assert.equal(isAuthRequired(new WorkflowError("x", WorkflowErrorCode.AGENT_EXECUTION_ERROR)), false);
    assert.equal(isAuthRequired(new Error("authentication required")), false);
    assert.equal(isAuthRequired(undefined), false);
    assert.equal(isAuthRequired("authentication required"), false);
  });
});

describe("WorkflowError.authContext", () => {
  it("round-trips the structured AuthErrorContext from options onto the readonly field", () => {
    const authContext: AuthErrorContext = {
      backendId: "codex",
      methods: [
        { id: "api-key", type: "agent", name: "API Key" },
        { id: "chat-gpt", type: "agent", name: "ChatGPT" },
        { id: "claude-login", type: "terminal" },
      ],
    };
    const e = new WorkflowError("ACP agent (codex) requires authentication", WorkflowErrorCode.AUTH_REQUIRED, {
      recoverable: false,
      authContext,
    });
    assert.equal(e.code, WorkflowErrorCode.AUTH_REQUIRED);
    assert.deepEqual(e.authContext, authContext);
    // The two method type discriminants (ACP schema 1.21.0) are exactly the allowed union values.
    assert.deepEqual(
      e.authContext?.methods.map((m) => m.type),
      ["agent", "agent", "terminal"],
    );
  });

  it("leaves authContext undefined when the option is omitted", () => {
    const e = new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(e.authContext, undefined);
  });
});

describe("WorkflowError.checkpointContext", () => {
  it("round-trips the structured CheckpointContext from options onto the readonly field", () => {
    const checkpointContext: CheckpointContext = {
      callIndex: 2,
      hash: "abc123",
      prompt: "Ship this release?",
      kind: "select",
      choices: ["ship", "hold"],
      default: "hold",
    };
    const error = new WorkflowError(
      'checkpoint "Ship this release?" awaits a human decision',
      WorkflowErrorCode.CHECKPOINT_REQUIRED,
      { recoverable: false, checkpointContext },
    );

    assert.equal(error.code, WorkflowErrorCode.CHECKPOINT_REQUIRED);
    assert.deepEqual(error.checkpointContext, checkpointContext);
  });

  it("leaves checkpointContext undefined when the option is omitted", () => {
    const error = new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(error.checkpointContext, undefined);
  });
});

describe("WorkflowError", () => {
  it("exposes the isolation recording and replay error codes as stable wire literals", () => {
    assert.equal(WorkflowErrorCode.RECORDING_UNUSABLE, "RECORDING_UNUSABLE");
    assert.equal(WorkflowErrorCode.REPLAY_TARGET_INVALID, "REPLAY_TARGET_INVALID");
    assert.equal(WorkflowErrorCode.REPLAY_DIVERGENCE, "REPLAY_DIVERGENCE");
    assert.equal(WorkflowErrorCode.AGENT_CANCELLED, "AGENT_CANCELLED");
  });

  it("types each strict-JSON recorded-error projection form", () => {
    const projections: WorkflowRecordedError[] = [
      {
        form: "workflow-error",
        message: "recording is incomplete",
        code: WorkflowErrorCode.RECORDING_UNUSABLE,
        recoverable: false,
        agentLabel: "researcher",
        details: { reason: "incomplete-manifest", indexes: [2] },
        resetHint: "record again",
        providerUsageLimitContext: {
          backendId: "codex",
          source: "provider",
          providerCode: "usageLimitExceeded",
        },
        authContext: { backendId: "codex", methods: [] },
        checkpointContext: {
          callIndex: 2,
          hash: "abc123",
          prompt: "Continue?",
          kind: "confirm",
        },
      },
      {
        form: "error",
        name: "RouteError",
        message: "route failed",
        props: { route: "codex" },
      },
      { form: "value", value: { stopped: true }, lossy: false },
    ];

    assert.deepEqual(
      projections.map((projection) => projection.form),
      ["workflow-error", "error", "value"],
    );
  });

  it("captures code, recoverable, resetHint, agentLabel, and details from options", () => {
    const providerUsageLimitContext: ProviderUsageLimitContext = {
      backendId: "claude",
      source: "provider",
      providerCode: "rate_limit",
      resetAt: "2026-07-15T08:00:00.000Z",
    };
    const e = new WorkflowError("Provider usage limit reached.", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
      recoverable: false,
      agentLabel: "researcher",
      resetHint: "Resets in ~3h",
      providerUsageLimitContext,
      details: { provider: "claude" },
    });
    assert.ok(e instanceof Error);
    assert.ok(e instanceof WorkflowError);
    assert.equal(e.name, "WorkflowError");
    assert.equal(e.message, "Provider usage limit reached.");
    assert.equal(e.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
    assert.equal(e.recoverable, false);
    assert.equal(e.agentLabel, "researcher");
    assert.equal(e.resetHint, "Resets in ~3h");
    assert.deepEqual(e.providerUsageLimitContext, providerUsageLimitContext);
    assert.deepEqual(e.details, { provider: "claude" });
  });

  it("defaults recoverable to false and leaves optional fields undefined when options omitted", () => {
    const e = new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(e.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(e.recoverable, false);
    assert.equal(e.agentLabel, undefined);
    assert.equal(e.resetHint, undefined);
    assert.equal(e.providerUsageLimitContext, undefined);
    assert.equal(e.details, undefined);
  });

  it("honors recoverable:true for transient codes", () => {
    const e = new WorkflowError("retry me", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
      recoverable: true,
      agentLabel: "writer",
    });
    assert.equal(e.recoverable, true);
    assert.equal(e.agentLabel, "writer");
  });
});
