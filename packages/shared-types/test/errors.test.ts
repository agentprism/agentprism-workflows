import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Ported from pi tests/errors.test.ts. Only the parts that now live in
// @automatalabs/shared-types are kept here: classifyProviderLimit, isProviderUsageLimit,
// and the WorkflowError class. wrapError moved to the engine and is covered by
// engine-core, so its describe block (and its import) are intentionally NOT ported here.
import {
  classifyProviderLimit,
  isAuthRequired,
  isProviderUsageLimit,
  WorkflowError,
  WorkflowErrorCode,
  type AuthErrorContext,
  type CheckpointContext,
  type WorkflowRecordedError,
} from "../src/errors.js";

describe("classifyProviderLimit", () => {
  it("matches the full provider usage/quota/rate-limit wording table", () => {
    // One representative string per alternative in the classifier's pattern table,
    // so adding/removing a wording in src/errors.ts is caught here.
    const cases = [
      "You have hit your ChatGPT usage limit (plus plan).", // usage limit
      "Codex usage limit reached (plus plan). Resets in ~3h.", // limit reached
      "insufficient_quota", // insufficient_quota (underscore form)
      "insufficient quota for this request", // insufficient quota (space form)
      "Your monthly quota exceeded for the org.", // quota exceeded
      "You exceeded your current quota, please check your plan and billing details.", // exceeded your current quota (+ billing)
      "You are out of budget for this billing cycle.", // out of budget
      "Your available balance is too low to continue.", // available balance
      "Remaining quota: 0 tokens", // bare \bquota\b
      "rate limit exceeded", // rate limit (space)
      "rate-limit hit, slow down", // rate.?limit (dash)
      "Error 429: too many requests", // \b429\b + too many requests
      "too many requests, back off", // too many requests (isolated)
      "GoUsageLimitError", // GoUsageLimitError
      "FreeUsageLimitError", // FreeUsageLimitError
      "Please update your billing information.", // \bbilling\b
    ];
    for (const text of cases) {
      assert.equal(classifyProviderLimit(text).matched, true, `should match: ${text}`);
    }
  });

  it("does NOT match benign text, transient overload/5xx, or empty input", () => {
    for (const text of [
      "file not found",
      "TypeError: x is not a function",
      "agent exploded",
      "overloaded_error: server is busy", // transient — deliberately excluded, stays recoverable
      "503 service unavailable",
      "",
      undefined,
    ]) {
      assert.equal(classifyProviderLimit(text).matched, false, `should not match: ${String(text)}`);
    }
  });

  it("extracts the verbatim reset hint when present, undefined otherwise", () => {
    assert.equal(
      classifyProviderLimit("Codex usage limit reached. Resets in ~3h.").resetHint,
      "Resets in ~3h",
    );
    assert.equal(
      classifyProviderLimit("usage limit reached, resets at 2026-06-20T06:00:00Z.").resetHint,
      "resets at 2026-06-20T06:00:00Z",
    );
    // matched but no "resets in/at ..." clause => resetHint undefined
    assert.equal(classifyProviderLimit("insufficient_quota").resetHint, undefined);
    assert.equal(classifyProviderLimit("rate limit exceeded").resetHint, undefined);
  });
});

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
        { id: "api-key", type: "env_var", name: "API Key" },
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
    // The three method type discriminants are exactly the allowed union values.
    assert.deepEqual(
      e.authContext?.methods.map((m) => m.type),
      ["env_var", "agent", "terminal"],
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
    const e = new WorkflowError("Codex usage limit reached. Resets in ~3h.", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
      recoverable: false,
      agentLabel: "researcher",
      resetHint: "Resets in ~3h",
      details: { provider: "codex" },
    });
    assert.ok(e instanceof Error);
    assert.ok(e instanceof WorkflowError);
    assert.equal(e.name, "WorkflowError");
    assert.equal(e.message, "Codex usage limit reached. Resets in ~3h.");
    assert.equal(e.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
    assert.equal(e.recoverable, false);
    assert.equal(e.agentLabel, "researcher");
    assert.equal(e.resetHint, "Resets in ~3h");
    assert.deepEqual(e.details, { provider: "codex" });
  });

  it("defaults recoverable to false and leaves optional fields undefined when options omitted", () => {
    const e = new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(e.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(e.recoverable, false);
    assert.equal(e.agentLabel, undefined);
    assert.equal(e.resetHint, undefined);
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
