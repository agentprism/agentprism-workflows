// End-to-end coverage of codex-acp's negotiated typed-session-failures extension against the MOCK
// ACP agent (test/fixtures/fake-acp-agent.mjs), driven through the real fluent client connection
// and the real runner. The fake plays the negotiated server: it ends a turn by REPORTING a failure
// on `PromptResponse._meta` (scenario `turn.responseMeta`) or by pushing one on a
// `session_info_update` (scenario `turn.updates`) instead of rejecting the request.
//
// The point of the suite is the seam contract: with the extension on, a walled turn must still
// surface as the SAME typed WorkflowError the legacy rejection produced — never as a successful
// empty turn — and with it off (no metadata), the legacy classification must be untouched.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import {
  CODEX_AIR_EXTENSION_VERSION,
  CODEX_AIR_META_KEYS,
  WorkflowErrorCode,
  isWorkflowError,
  type AgentUsage,
} from "@automatalabs/shared-types";
import { TYPED_SESSION_FAILURE_CLIENT_CAPABILITY, type TypedSessionFailure } from "../src/index.js";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

const SCHEMA = Type.Object({ ok: Type.Boolean() });

interface LogEntry {
  method: string;
  params?: {
    clientCapabilities?: { _meta?: Record<string, unknown> | null };
  };
}

const harness = createFakeAgentHarness({ prefix: "acp-typed-failure-it-" });
const { makeRunner } = harness;
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);

afterEach(async () => {
  await harness.cleanup();
});

/** A typed failure record in the server's own shape (partial overrides over a benign default). */
function failure(overrides: Partial<TypedSessionFailure> = {}): Record<string, unknown> {
  return {
    id: "turn-1:error",
    revision: 1,
    phase: "active",
    category: "internal_error",
    source: "codex",
    safeMessage: "Codex encountered an internal error.",
    retryable: true,
    actions: ["retry"],
    ...overrides,
  };
}

/** The `_meta` envelope both delivery channels use. */
function failureMeta(record: Record<string, unknown>): Record<string, unknown> {
  return {
    [CODEX_AIR_META_KEYS.namespace]: {
      [CODEX_AIR_META_KEYS.extension]: {
        [CODEX_AIR_META_KEYS.version]: CODEX_AIR_EXTENSION_VERSION,
        [CODEX_AIR_META_KEYS.sessionFailure]: record,
      },
    },
  };
}

/** An asynchronous delivery: the failure rides a `session_info_update` mid-turn. */
function failureUpdate(record: Record<string, unknown>): Record<string, unknown> {
  return { sessionUpdate: "session_info_update", _meta: failureMeta(record) };
}

function initializeMeta(log: LogEntry[]): Record<string, unknown> | null | undefined {
  return log.find((entry) => entry.method === "initialize")?.params?.clientCapabilities?._meta;
}

// ---- advertisement on the wire --------------------------------------------------------

test("the codex backend advertises the typed-failure capability at initialize", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  await makeRunner().run("hi", { model: "codex", cwd });

  assert.deepEqual(initializeMeta(readLog()), TYPED_SESSION_FAILURE_CLIENT_CAPABILITY);
});

test("no other backend advertises it (the handshake stays byte-identical for them)", async () => {
  for (const model of ["claude", "opencode", "pi"] as const) {
    const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
    await makeRunner().run("hi", { model, cwd });
    assert.equal(initializeMeta(readLog()), undefined, model);
    await harness.cleanup();
  }
});

// ---- terminal delivery (PromptResponse._meta) -----------------------------------------

test("a terminal typed failure fails the turn instead of resolving it as empty output", async () => {
  const { cwd } = configure({
    turns: [{
      responseMeta: failureMeta(failure({
        category: "transport_lost",
        safeMessage: "Connection to Codex was lost.",
        retryable: true,
        actions: ["reconnect", "retry"],
        turnId: "turn-1",
      })),
    }],
  });

  await assert.rejects(
    () => makeRunner().run("hi", { model: "codex", cwd, label: "typed-terminal" }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(err.recoverable, true, "retryable: true => the engine may retry");
      assert.equal(err.agentLabel, "typed-terminal");
      assert.match(err.message, /Connection to Codex was lost\./);
      assert.match(err.message, /transport_lost; suggested: reconnect, retry/);
      assert.equal((err.details as TypedSessionFailure).turnId, "turn-1");
      return true;
    },
  );
});

test("a terminal auth_required failure becomes AUTH_REQUIRED with the advertised methods", async () => {
  const { cwd } = configure({
    authMethods: [{ id: "api-key", name: "API Key" }, { id: "chat-gpt", name: "ChatGPT" }],
    turns: [{
      responseMeta: failureMeta(failure({
        category: "auth_required",
        safeMessage: "Sign in to continue using Codex.",
        retryable: false,
        actions: ["login"],
      })),
    }],
  });

  await assert.rejects(
    () => makeRunner().run("hi", { model: "codex", cwd, label: "typed-auth" }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.AUTH_REQUIRED);
      assert.equal(err.recoverable, false);
      assert.deepEqual(err.authContext, {
        backendId: "codex",
        methods: [
          { id: "api-key", type: "agent", name: "API Key" },
          { id: "chat-gpt", type: "agent", name: "ChatGPT" },
        ],
      });
      return true;
    },
  );
});

test("a terminal quota_exhausted failure becomes the resumable PROVIDER_USAGE_LIMIT", async () => {
  const { cwd } = configure({
    turns: [{
      responseMeta: failureMeta(failure({
        category: "quota_exhausted",
        safeMessage: "The Codex usage quota is exhausted.",
        retryable: false,
        actions: ["new_session"],
      })),
    }],
  });

  await assert.rejects(
    () => makeRunner().run("hi", { model: "codex", cwd }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
      assert.equal(err.recoverable, false);
      assert.deepEqual(err.providerUsageLimitContext, {
        backendId: "codex",
        source: "provider",
        providerCode: "quota_exhausted",
      });
      return true;
    },
  );
});

test("a non-retryable terminal failure fails fast instead of burning the retry budget", async () => {
  const { cwd } = configure({
    turns: [{
      responseMeta: failureMeta(failure({
        category: "context_exhausted",
        safeMessage: "This conversation has reached its context limit.",
        retryable: false,
        actions: ["new_turn"],
      })),
    }],
  });

  await assert.rejects(
    () => makeRunner().run("hi", { model: "codex", cwd }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(err.recoverable, false);
      return true;
    },
  );
});

test("a terminal failure pre-empts the schema-repair ladder", async () => {
  const { cwd, readLog } = configure({
    turns: [{
      responseMeta: failureMeta(failure({ category: "overloaded", safeMessage: "Codex is temporarily overloaded." })),
    }],
  });

  await assert.rejects(
    () => makeRunner().run("classify", { model: "codex", cwd, schema: SCHEMA }),
    (err: unknown) => isWorkflowError(err) && err.code === WorkflowErrorCode.AGENT_EXECUTION_ERROR,
  );
  // No repair turns: the failure is reported before the structured-output ladder can reprompt.
  assert.equal(readLog().filter((entry) => entry.method === "prompt").length, 1);
});

test("a terminal failure still reports the tokens the walled turn burned", async () => {
  const { cwd } = configure({
    turns: [{
      usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 },
      responseMeta: failureMeta(failure({ category: "internal_error" })),
    }],
  });
  const usages: AgentUsage[] = [];

  await assert.rejects(
    () => makeRunner().run("hi", { model: "codex", cwd, onUsage: (usage) => usages.push(usage) }),
    (err: unknown) => isWorkflowError(err),
  );
  // The response usage is recorded BEFORE the typed failure is raised, so a walled turn never
  // loses the accounting for the tokens it already spent.
  assert.equal(usages.length, 1);
  assert.equal(usages[0]?.input, 11);
  assert.equal(usages[0]?.output, 3);
  assert.equal(usages[0]?.total, 14);
});

// ---- asynchronous delivery (session_info_update) ---------------------------------------

test("an asynchronous typed failure explains a turn that produced nothing", async () => {
  const { cwd } = configure({
    turns: [{
      updates: [failureUpdate(failure({
        id: "fake-session:error:epoch-1",
        category: "policy_denied",
        safeMessage: "The request was blocked by provider policy.",
        retryable: false,
        actions: [],
      }))],
    }],
  });

  await assert.rejects(
    () => makeRunner().run("hi", { model: "codex", cwd, label: "typed-async" }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(err.recoverable, false);
      assert.equal(err.agentLabel, "typed-async");
      assert.match(err.message, /The request was blocked by provider policy\./);
      assert.equal((err.details as TypedSessionFailure).category, "policy_denied");
      return true;
    },
  );
});

test("an asynchronous typed failure never retroactively fails a turn that answered", async () => {
  const { cwd } = configure({
    turns: [{
      updates: [failureUpdate(failure({ id: "fake-session:error:epoch-1", category: "provider_error" }))],
      text: "the answer",
    }],
  });

  // The server itself does not treat an unattributed late error as terminal for a turn that
  // produced output, and neither do we.
  assert.equal(await makeRunner().run("hi", { model: "codex", cwd }), "the answer");
});

test("a cleared phase retires the latch: an empty turn falls back to AGENT_EMPTY_OUTPUT", async () => {
  const { cwd } = configure({
    turns: [{
      updates: [
        failureUpdate(failure({ id: "recovered:error", revision: 1, category: "transport_lost" })),
        failureUpdate(failure({ id: "recovered:error", revision: 2, phase: "cleared", category: "transport_lost" })),
      ],
    }],
  });

  await assert.rejects(
    () => makeRunner().run("hi", { model: "codex", cwd }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.AGENT_EMPTY_OUTPUT, "a cleared failure must not stay latched");
      assert.equal(err.recoverable, true);
      return true;
    },
  );
});

test("a stale revision cannot roll the latch back to an older record", async () => {
  const { cwd } = configure({
    turns: [{
      updates: [
        failureUpdate(failure({ id: "same:error", revision: 2, category: "quota_exhausted", retryable: false })),
        // Re-delivery of the superseded record — and a stale `cleared` frame for the same id.
        failureUpdate(failure({ id: "same:error", revision: 1, category: "internal_error", retryable: true })),
        failureUpdate(failure({ id: "same:error", revision: 1, phase: "cleared", category: "internal_error" })),
      ],
    }],
  });

  await assert.rejects(
    () => makeRunner().run("hi", { model: "codex", cwd }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, "revision 2 stayed latched");
      assert.equal((err.details as TypedSessionFailure).revision, 2);
      return true;
    },
  );
});

test("a failure latched by an earlier turn is not attributed to a later empty one", async () => {
  const { cwd } = configure({
    turns: [
      { updates: [failureUpdate(failure({ id: "earlier:error", category: "provider_error" }))], text: "first" },
      {},
    ],
  });
  const runner = makeRunner();

  assert.equal(await runner.run("one", { model: "codex", cwd }), "first");
  // A pooled process serves both runs, but each run opens its own session, so the second turn
  // starts from a clean latch and reports the ordinary empty-output error.
  await assert.rejects(
    () => runner.run("two", { model: "codex", cwd }),
    (err: unknown) => isWorkflowError(err) && err.code === WorkflowErrorCode.AGENT_EMPTY_OUTPUT,
  );
});

// ---- fallback: no metadata => the legacy path, untouched --------------------------------

test("without typed metadata the legacy thrown-error classification is unchanged", async () => {
  const { cwd } = configure({
    turns: [{
      throw: "You've hit your usage limit.",
      throwData: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" },
    }],
  });

  await assert.rejects(
    () => makeRunner().run("hi", { model: "codex", cwd }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
      assert.equal(err.recoverable, false);
      // The legacy channel keeps reporting the raw codexErrorInfo discriminant.
      assert.equal(err.providerUsageLimitContext?.providerCode, "usageLimitExceeded");
      return true;
    },
  );
});

test("without typed metadata an empty turn is still AGENT_EMPTY_OUTPUT, and a normal turn still succeeds", async () => {
  const empty = configure({ turns: [{ text: "   " }] });
  await assert.rejects(
    () => makeRunner().run("hi", { model: "codex", cwd: empty.cwd }),
    (err: unknown) => isWorkflowError(err) && err.code === WorkflowErrorCode.AGENT_EMPTY_OUTPUT,
  );
  await harness.cleanup();

  const ok = configure({ turns: [{ text: "hello" }] });
  assert.equal(await makeRunner().run("hi", { model: "codex", cwd: ok.cwd }), "hello");
});

test("a session_info_update carrying unrelated metadata leaves the latch alone", async () => {
  const { cwd } = configure({
    turns: [{
      updates: [
        { sessionUpdate: "session_info_update", title: "A titled session" },
        { sessionUpdate: "session_info_update", _meta: { quota: { plan: "pro" } } },
        // A malformed typed payload must be treated as absent, not half-trusted.
        { sessionUpdate: "session_info_update", _meta: failureMeta({ ...failure(), phase: "pending" }) },
      ],
    }],
  });

  await assert.rejects(
    () => makeRunner().run("hi", { model: "codex", cwd }),
    (err: unknown) => isWorkflowError(err) && err.code === WorkflowErrorCode.AGENT_EMPTY_OUTPUT,
  );
});
