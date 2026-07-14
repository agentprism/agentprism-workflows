// Test for the @automatalabs/workflows SDK facade.
//
// Drives a TINY workflow through the public barrel using a STUB AgentRunner (the
// engine's frozen seam — run() returns the RAW value: text when no schema), so the
// suite exercises the facade + the runDynamicWorkflow helper with NO live ACP backend.
// Modeled on the mcp-server test harness (packages/mcp-server/test/_harness.ts): the
// stub double + the disposable-HOME isolation so WorkflowManager run persistence
// (~/.agentprism/workflows/projects/<key>/runs) writes into a throwaway temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Redirect run-state persistence into a disposable home BEFORE any WorkflowManager is
// constructed (runDynamicWorkflow builds one per call, deriving the runs dir from $HOME
// at construction time). Setting it at module load fully isolates the suite's on-disk runs.
const TEST_HOME = mkdtempSync(join(tmpdir(), "automatalabs-workflows-test-home-"));
process.env.HOME = TEST_HOME;
process.on("exit", () => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of the throwaway home */
  }
});

// Import EXCLUSIVELY from the SDK barrel — this is the facade under test.
import {
  AcpAgentRunner,
  createAcpRunner,
  WorkflowManager,
  runWorkflow,
  runDynamicWorkflow,
  WorkflowError,
  WorkflowErrorCode,
  isAuthRequired,
  isProviderUsageLimit,
  TypedEventEmitter,
  toJsonSchema,
  AGENTPRISM_PERSISTENCE_ROOT_ENV,
} from "../src/index.js";
import type {
  AcpEventContext,
  AcpEventListener,
  AcpEventName,
  AcpRunnerEventMap,
  AgentEventPayload,
  AgentRunner,
  RunOptions,
  PersistedAgentState,
  PersistedRunState,
  RunPersistenceOptions,
  WorkflowPathOptions,
  // §4.2 type re-exports — the runner-facing auth surface the SDK facade re-exports.
  // Imported here as a compile-gate: PR6's value export must resolve alongside these
  // (which landed with PR5), and a broken facade re-export chain would fail to type-check.
  AuthResolver,
  AuthContext,
  AuthResolution,
  AuthMethodDescriptor,
  CompleteAuthOptions,
  AuthOutcome,
  AuthController,
  AuthStatusSnapshot,
  AuthCapableRunner,
  AuthErrorContext,
  CheckpointContext,
  JournalCallMetadata,
  WorkflowLogTail,
  WorkflowRunCallStatus,
  WorkflowRunInspectionOptions,
  WorkflowRunStatus,
  WorkflowRunStatusTruncation,
} from "../src/index.js";

/**
 * Build an AgentRunner test double from a plain implementation. The seam's run() is
 * generic over the optional typebox schema; this stub is schema-less and returns raw
 * text, bridged to the generic interface with a single `as AgentRunner` (never `as any`),
 * exactly as the mcp-server harness does.
 */
function makeRunner(impl: (prompt: string, options: RunOptions) => unknown | Promise<unknown>): AgentRunner {
  const run = async (prompt: string, options?: RunOptions): Promise<unknown> => impl(prompt, options ?? {});
  return { run } as AgentRunner;
}

/** A runner that echoes a deterministic, non-empty text reply for every agent() call. */
function okRunner(reply: (prompt: string) => string = (p) => `stub:${p}`): AgentRunner {
  return makeRunner((prompt) => reply(prompt));
}

/**
 * AgentRunner test double with the ACP event-bus extension. The manager bridge is intentionally
 * attached to the REAL public seam (`new WorkflowManager({ agent })`), so this fake emits the same
 * bus events an AcpAgentRunner would emit while keeping the workflow fully local and deterministic.
 */
class EventedRunner {
  private readonly events = new TypedEventEmitter<AcpRunnerEventMap>();
  readonly sessionId = "session-1";
  readonly backendId = "claude";
  private readonly waitForRun: (() => Promise<void>) | undefined;
  private readonly failWith: Error | undefined;

  constructor(options: { waitForRun?: () => Promise<void>; failWith?: Error } = {}) {
    this.waitForRun = options.waitForRun;
    this.failWith = options.failWith;
  }

  on<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void {
    return this.events.on(name, listener);
  }

  listenerCount(name: AcpEventName): number {
    return this.events.listenerCount(name);
  }

  emit<K extends AcpEventName>(name: K, event: AcpRunnerEventMap[K]): void {
    this.events.emit(name, event);
  }

  async run(prompt: string, options?: RunOptions): Promise<unknown> {
    const ctx = this.context(options);
    this.emit("session_open", ctx);

    const update = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "live" },
    } as AcpRunnerEventMap["session_update"]["update"];
    this.emit("session_update", { ...ctx, update });
    this.emit("agent_message_chunk", { ...ctx, ...update } as AcpRunnerEventMap["agent_message_chunk"]);

    await this.waitForRun?.();
    if (this.failWith) throw this.failWith;
    this.emit("session_close", ctx);
    return `evented:${prompt}`;
  }

  private context(options?: RunOptions): AcpEventContext {
    return {
      sessionId: this.sessionId,
      backendId: this.backendId,
      label: options?.label,
      runId: options?.runId,
    };
  }
}

function eventedAgent(runner: EventedRunner): AgentRunner {
  return runner as unknown as AgentRunner;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

/** Valid one-agent script: meta first, exactly one agent() call, returns its result. */
const ONE_AGENT_SCRIPT = [
  'export const meta = { name: "one-agent", description: "a single subagent" };',
  'const r = await agent("hello");',
  "return r;",
].join("\n");

const NO_AGENT_SCRIPT = [
  'export const meta = { name: "no-agent", description: "no subagents" };',
  "return 42;",
].join("\n");

const CHECKPOINT_THEN_AGENT_SCRIPT = [
  'export const meta = { name: "checkpoint-then-agent", description: "pause before one subagent" };',
  'const decision = await checkpoint("q", { headless: "pause" });',
  'const result = await agent("after:" + decision);',
  "return { decision, result };",
].join("\n");

async function createResumableRun(manager: WorkflowManager): Promise<string> {
  const result = await manager.runSync(ONE_AGENT_SCRIPT, undefined, {
    agent: makeRunner(() => {
      throw new WorkflowError("provider usage limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
        recoverable: false,
      });
    }),
  });
  assert.equal(result.status, "paused", "fixture run should persist a resumable pause");
  return result.runId;
}

async function createCheckpointPausedRun(
  manager: WorkflowManager,
  runner: EventedRunner,
): Promise<{ runId: string; context: CheckpointContext }> {
  const result = await manager.runSync(CHECKPOINT_THEN_AGENT_SCRIPT, undefined, {
    agent: eventedAgent(runner),
  });
  assert.equal(result.status, "paused", "fixture run should pause at the durable checkpoint");
  const context = result.checkpointContext;
  assert.ok(context, "fixture pause should expose checkpoint context");
  return { runId: result.runId, context };
}

test("facade re-exports the public surface", () => {
  assert.equal(typeof createAcpRunner, "function");
  assert.equal(typeof WorkflowManager, "function");
  assert.equal(typeof runWorkflow, "function");
  assert.equal(typeof runDynamicWorkflow, "function");
  assert.equal(typeof WorkflowError, "function");
  assert.equal(typeof toJsonSchema, "function");
  assert.equal(AGENTPRISM_PERSISTENCE_ROOT_ENV, "AGENTPRISM_PERSISTENCE_ROOT");
  const pathOptions: WorkflowPathOptions = { persistenceRoot: "/tmp/agentprism-workflows-test" };
  const runPersistenceOptions: RunPersistenceOptions = pathOptions;
  const persistedAgent: PersistedAgentState = {
    id: 1,
    label: "persisted-agent",
    prompt: "hello",
    status: "done",
  };
  const persistedRun: PersistedRunState = {
    runId: "persisted-run",
    workflowName: "persisted-workflow",
    script: NO_AGENT_SCRIPT,
    status: "completed",
    phases: [],
    agents: [persistedAgent],
    logs: [],
    startedAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  assert.equal(runPersistenceOptions.persistenceRoot, pathOptions.persistenceRoot);
  assert.equal(persistedRun.agents[0], persistedAgent);
  const checkpointContext: CheckpointContext = {
    callIndex: 1,
    hash: "hash",
    prompt: "Continue?",
    kind: "confirm",
  };
  assert.equal(checkpointContext.callIndex, 1);
  const callMetadata: JournalCallMetadata = { kind: "agent", label: "review" };
  const inspectionOptions: WorkflowRunInspectionOptions = { lastN: 1, logLines: 0 };
  const tail: WorkflowLogTail = {
    lines: [],
    totalLines: 0,
    omittedLines: 0,
    truncatedLines: 0,
    redactedLines: 0,
  };
  const callStatus: WorkflowRunCallStatus = {
    index: 0,
    kind: "agent",
    label: "review",
    resultPreview: "true",
    resultRedacted: false,
    resultTruncated: false,
  };
  const truncation: WorkflowRunStatusTruncation = {
    maxStructuredBytes: 24_576,
    byteCapApplied: false,
    phases: { total: 0, returned: 0, shortened: 0 },
    logs: { total: 0, returned: 0, shortened: 0, redacted: 0 },
    calls: { total: 1, matched: 1, returned: 1, shortenedResults: 0, redactedResults: 0 },
  };
  const status: WorkflowRunStatus = {
    runId: "a-b",
    status: "completed",
    workflowName: "review",
    phases: [],
    logTail: tail,
    calls: [callStatus],
    filter: { lastN: inspectionOptions.lastN ?? 20, logLines: inspectionOptions.logLines ?? 20 },
    truncation,
  };
  assert.equal(callMetadata.label, status.calls[0]?.label);
});

test("facade WorkflowManager exposes inspectRun and shared status without engine imports", async () => {
  const manager = new WorkflowManager({ agent: okRunner() });
  const result = await manager.runSync(ONE_AGENT_SCRIPT);
  const status: WorkflowRunStatus | undefined = manager.inspectRun(result.runId, { lastN: 1, logLines: 0 });
  assert.equal(status?.status, "completed");
  assert.equal(status?.workflowName, "one-agent");
  assert.equal(status?.calls.length, 1);
  assert.equal(status?.filter.lastN, 1);
  assert.equal(status?.filter.logLines, 0);
});

// §4.2 SDK exports (PR6). The facade re-exports the `isAuthRequired` VALUE through the
// @automatalabs/workflow-engine chain (threaded in PR1) so a host can classify an
// AUTH_REQUIRED fault with the same one-liner it uses for isProviderUsageLimit — no new
// behavior, just surface. The §4.2 TYPE re-exports (AuthResolver, AuthContext, …) landed
// with PR5; they are compile-gated below so a broken facade chain fails type-checking.
test("facade re-exports isAuthRequired as a value alongside isProviderUsageLimit (§4.2)", () => {
  assert.equal(typeof isAuthRequired, "function");
  assert.equal(typeof isProviderUsageLimit, "function");

  // True ONLY for an AUTH_REQUIRED WorkflowError, and it narrows to WorkflowError so the
  // caller can read `.authContext` (the non-secret structured surface) after the guard.
  const authErr: unknown = new WorkflowError("authentication required", WorkflowErrorCode.AUTH_REQUIRED, {
    authContext: { backendId: "claude", methods: [{ id: "gateway", type: "agent", name: "Gateway" }] },
  });
  assert.equal(isAuthRequired(authErr), true);
  if (isAuthRequired(authErr)) {
    assert.equal(authErr.code, WorkflowErrorCode.AUTH_REQUIRED);
    assert.equal(authErr.authContext?.backendId, "claude");
  } else {
    assert.fail("isAuthRequired should narrow the AUTH_REQUIRED WorkflowError");
  }

  // A different WorkflowErrorCode must NOT classify as auth (and must not collide with the
  // sibling usage-limit guard) — the two helpers partition disjoint faults.
  const usageErr = new WorkflowError("usage limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
  assert.equal(isAuthRequired(usageErr), false);
  assert.equal(isProviderUsageLimit(usageErr), true);
  assert.equal(isProviderUsageLimit(authErr), false);

  // Non-WorkflowError values never classify.
  assert.equal(isAuthRequired(new Error("authentication required")), false);
  assert.equal(isAuthRequired({ code: WorkflowErrorCode.AUTH_REQUIRED }), false);
  assert.equal(isAuthRequired(undefined), false);
  assert.equal(isAuthRequired(null), false);
});

// Compile-gate for the §4.2 runner-facing auth TYPE re-exports (surfaced through the facade
// with PR5). If any re-export were dropped or renamed, referencing it here fails `tsc` — and
// the spawned "tsc type-checks this suite" test below is what makes that bite: the build
// tsconfig is src-only and tsx strips types, so without it a broken re-export would still
// pass the suite. The runtime assertions here are trivially true — the value is the type
// wiring compiling at all.
test("facade re-exports the §4.2 runner-facing auth types", () => {
  const descriptor: AuthMethodDescriptor = {
    type: "env_var",
    id: "openai",
    name: "OpenAI",
    vars: [{ name: "OPENAI_API_KEY", secret: true, optional: false }],
  };
  const resolution: AuthResolution = { outcome: "env", values: { OPENAI_API_KEY: "sk-x" }, methodId: "openai" };
  const context: AuthContext = { backendId: "claude", methods: [descriptor], cause: "proactive" };
  const completeOpts: CompleteAuthOptions = { methodId: "openai", resolution };
  const outcome: AuthOutcome = { status: "authenticated", methodId: "openai", recycled: false };
  const errorContext: AuthErrorContext = { methods: [{ id: "openai", type: "env_var" }] };
  const snapshot: AuthStatusSnapshot = {
    backendId: "claude",
    poolKey: "claude",
    state: "unauthenticated",
    authenticated: false,
    canResume: false,
    methods: [{ id: "openai", type: "env_var", name: "OpenAI" }],
  };
  // Function/interface typedefs referenced purely as compile-gates through the facade barrel.
  const resolver: AuthResolver = async () => resolution;
  const controller: AuthController | undefined = undefined;
  const capable: AuthCapableRunner | undefined = undefined;

  assert.equal(descriptor.type, "env_var");
  assert.equal(resolution.outcome, "env");
  assert.equal(context.cause, "proactive");
  assert.equal(completeOpts.methodId, "openai");
  assert.equal(outcome.status, "authenticated");
  assert.equal(errorContext.methods[0]?.type, "env_var");
  assert.equal(snapshot.state, "unauthenticated");
  assert.equal(typeof resolver, "function");
  assert.equal(controller, undefined);
  assert.equal(capable, undefined);
});

test("createAcpRunner exposes a typed ACP event bus (on/once/off/listenerCount) via the barrel", async () => {
  const runner = createAcpRunner();
  try {
    const seen: string[] = [];
    // Typed listener: `e` is the agent_message_chunk variant + context — compile-gated through
    // the SDK barrel. The payload is assignable to AcpEventContext, proving the envelope is carried.
    const off = runner.on("agent_message_chunk", (e: AcpRunnerEventMap["agent_message_chunk"]) => {
      if (e.content.type === "text") seen.push(e.content.text);
      const ctx: AcpEventContext = e;
      void ctx;
    });
    assert.equal(typeof off, "function", "on() returns an unsubscribe thunk");
    assert.equal(runner.listenerCount("agent_message_chunk"), 1);

    const toolListener = (e: AcpRunnerEventMap["tool_call"]) => void e.title;
    runner.on("tool_call", toolListener);
    assert.equal(runner.listenerCount("tool_call"), 1);

    off();
    assert.equal(runner.listenerCount("agent_message_chunk"), 0, "disposer unsubscribed");
    runner.off("tool_call", toolListener);
    assert.equal(runner.listenerCount("tool_call"), 0);

    runner.once("session_update", () => {});
    assert.equal(runner.listenerCount("session_update"), 1);
    runner.removeAllListeners();
    assert.equal(runner.listenerCount("session_update"), 0);
  } finally {
    await runner.dispose();
  }
});

test("RunOptions exposes Codex baseInstructions/developerInstructions through the SDK barrel", () => {
  // Compile-gate: the two additive Codex-only seam fields are typed on RunOptions as re-exported
  // by @automatalabs/workflows, so SDK users get createAcpRunner().run(p, { baseInstructions }).
  const opts: RunOptions = {
    baseInstructions: "You only write Rust.",
    developerInstructions: "Prefer iterators.",
  };
  assert.equal(opts.baseInstructions, "You only write Rust.");
  assert.equal(opts.developerInstructions, "Prefer iterators.");
});

test("runDynamicWorkflow runs a 1-agent script through a stub runner", async () => {
  const result = await runDynamicWorkflow(ONE_AGENT_SCRIPT, { runner: okRunner() });

  assert.equal(result.status, "completed");
  assert.equal(result.meta.name, "one-agent");
  assert.equal(result.agentCount, 1);
  // The stub echoes `stub:<prompt>`; the script returns the single agent() result verbatim.
  assert.equal(result.result, "stub:hello");
});

test("runDynamicWorkflow disposes the ACP runner it creates internally", async (t) => {
  const originalDispose = AcpAgentRunner.prototype.dispose;
  const dispose = t.mock.method(AcpAgentRunner.prototype, "dispose", function (this: AcpAgentRunner) {
    return originalDispose.call(this);
  });

  const result = await runDynamicWorkflow(NO_AGENT_SCRIPT);

  assert.equal(result.status, "completed");
  assert.equal(result.result, 42);
  assert.equal(dispose.mock.callCount(), 1, "owned default runner should be disposed after the run");
});

test("runDynamicWorkflow does not dispose a caller-supplied runner", async () => {
  let disposeCalls = 0;
  const runner = Object.assign(okRunner(), {
    async dispose() {
      disposeCalls++;
    },
  });

  const result = await runDynamicWorkflow(ONE_AGENT_SCRIPT, { runner });

  assert.equal(result.status, "completed");
  assert.equal(disposeCalls, 0, "caller retains ownership of an injected runner");
});

test("runDynamicWorkflow threads opts.cwd through to every agent session", async () => {
  const runCwd = tmpdir();
  let captured: string | undefined;
  const capturing = makeRunner((_prompt, options) => {
    captured = options.cwd;
    return "ok";
  });

  const result = await runDynamicWorkflow(ONE_AGENT_SCRIPT, { runner: capturing, cwd: runCwd });

  assert.equal(result.status, "completed");
  assert.equal(captured, runCwd);
});

test("runDynamicWorkflow detaches its one-off manager agentEvent bridge", async () => {
  const runner = new EventedRunner();
  const result = await runDynamicWorkflow(ONE_AGENT_SCRIPT, { runner: eventedAgent(runner) });

  assert.equal(result.status, "completed");
  assert.equal(runner.listenerCount("session_update"), 0);
  assert.equal(runner.listenerCount("session_open"), 0);
});

test("WorkflowManager.runSync runs the same script with an injected stub runner", async () => {
  const manager = new WorkflowManager({ agent: okRunner((p) => `mgr:${p}`) });
  const result = await manager.runSync(ONE_AGENT_SCRIPT);

  assert.equal(result.status, "completed");
  assert.equal(result.result, "mgr:hello");
});

test("WorkflowManager forwards injected runner live ACP events as agentEvent", async () => {
  const runner = new EventedRunner();
  const manager = new WorkflowManager({ agent: eventedAgent(runner) });
  const order: string[] = [];
  const events: AgentEventPayload[] = [];

  manager.on("agentStart", () => order.push("agentStart"));
  manager.on("agentEvent", (event: AgentEventPayload) => {
    order.push(`agentEvent:${event.name}`);
    events.push(event);
  });
  manager.on("agentEnd", () => order.push("agentEnd"));

  const script = [
    'export const meta = { name: "live-agent", description: "live stream" };',
    'const r = await agent("hello", { label: "live-label" });',
    "return r;",
  ].join("\n");
  const result = await manager.runSync(script);

  assert.equal(result.status, "completed");
  assert.equal(result.result, "evented:hello");
  assert.deepEqual(order, [
    "agentStart",
    "agentEvent:session_open",
    "agentEvent:agent_message_chunk",
    "agentEvent:session_close",
    "agentEnd",
  ]);

  const chunk = events.find((event): event is AgentEventPayload<"agent_message_chunk"> => {
    return event.name === "agent_message_chunk";
  });
  assert.ok(chunk, "session_update catch-all should forward once as the inner discriminant");
  assert.equal(chunk.runId, result.runId);
  assert.equal(chunk.label, "live-label");
  assert.equal(chunk.sessionId, runner.sessionId);
  assert.equal(chunk.backendId, runner.backendId);
  assert.equal(chunk.event.content.type, "text");
  assert.equal(chunk.event.content.type === "text" ? chunk.event.content.text : "", "live");
  assert.equal(runner.listenerCount("session_update"), 1, "constructor bridge survives run settlement");
  manager.dispose();
  assert.equal(runner.listenerCount("session_update"), 0, "dispose removes constructor bridge");
});

test("WorkflowManager removes exec runner bridge after runSync settles", async () => {
  const runner = new EventedRunner();
  const manager = new WorkflowManager();

  const result = await manager.runSync(ONE_AGENT_SCRIPT, undefined, { agent: eventedAgent(runner) });

  assert.equal(result.status, "completed");
  assert.equal(runner.listenerCount("session_update"), 0);
  assert.equal(runner.listenerCount("session_open"), 0);
});

test("WorkflowManager keeps a shared exec runner bridge until concurrent runs settle", async () => {
  const gates: Array<ReturnType<typeof deferred>> = [];
  const runner = new EventedRunner({
    waitForRun: () => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
  });
  const agent = eventedAgent(runner);
  const manager = new WorkflowManager();

  const first = manager.runSync(ONE_AGENT_SCRIPT, undefined, { agent });
  const second = manager.runSync(ONE_AGENT_SCRIPT, undefined, { agent });
  await waitUntil(() => gates.length === 2, "both concurrent runs should reach the runner");

  assert.equal(runner.listenerCount("session_update"), 1, "shared runner is subscribed once");
  assert.equal(runner.listenerCount("session_open"), 1);

  gates[0]?.resolve();
  assert.equal((await first).status, "completed");
  assert.equal(runner.listenerCount("session_update"), 1, "bridge remains until the second run settles");

  gates[1]?.resolve();
  assert.equal((await second).status, "completed");
  assert.equal(runner.listenerCount("session_update"), 0, "bridge is removed after the final release");
  assert.equal(runner.listenerCount("session_open"), 0);
});

test("WorkflowManager.resume keeps the exec runner bridge until the resumed run settles", async () => {
  const manager = new WorkflowManager();
  const runId = await createResumableRun(manager);
  const gate = deferred();
  const runner = new EventedRunner({ waitForRun: () => gate.promise });
  const seen: AgentEventPayload[] = [];
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event));

  const accepted = await manager.resume(runId, { agent: eventedAgent(runner) });
  assert.equal(accepted, true);
  assert.equal(runner.listenerCount("session_update"), 1, "bridge remains after resume is accepted");
  assert.equal(runner.listenerCount("session_open"), 1);

  runner.emit("session_open", {
    sessionId: "after-resume-return",
    backendId: runner.backendId,
    runId,
  });
  assert.equal(
    seen.filter((event) => event.name === "session_open" && event.sessionId === "after-resume-return").length,
    1,
    "events emitted after resume returns are still forwarded",
  );

  gate.resolve();
  await waitUntil(() => manager.getRun(runId)?.status === "completed", "resumed run should complete");
  await waitUntil(
    () => runner.listenerCount("session_update") === 0 && runner.listenerCount("session_open") === 0,
    "bridge should release after the resumed run settles",
  );

  const forwardedBeforePostSettlementEvent = seen.length;
  runner.emit("session_open", {
    sessionId: "after-resume-settlement",
    backendId: runner.backendId,
    runId,
  });
  assert.equal(seen.length, forwardedBeforePostSettlementEvent, "settled resume no longer forwards runner events");
});

test("WorkflowManager.resume releases the exec runner bridge when a durable checkpoint re-pauses", async () => {
  const manager = new WorkflowManager();
  const runner = new EventedRunner();
  const { runId } = await createCheckpointPausedRun(manager, runner);
  const seen: AgentEventPayload[] = [];
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event));
  assert.equal(runner.listenerCount("session_update"), 0, "the fixture run released its exec bridge");
  assert.equal(runner.listenerCount("session_open"), 0);

  const accepted = await manager.resume(runId, { agent: eventedAgent(runner) });

  assert.equal(accepted, true, "the reply-less checkpoint resume is accepted and re-pauses");
  await waitUntil(
    () => runner.listenerCount("session_update") === 0 && runner.listenerCount("session_open") === 0,
    "the bridge should release after the re-pause rejection settles",
  );
  assert.equal(manager.getRun(runId)?.status, "paused");

  const forwardedBeforePostSettlementEvent = seen.length;
  runner.emit("session_open", { sessionId: "after-re-pause", backendId: runner.backendId, runId });
  assert.equal(
    seen.length,
    forwardedBeforePostSettlementEvent,
    "runner events are not forwarded after the re-pause settles",
  );
});

test("WorkflowManager.resume releases the exec runner bridge when the resumed run fails", async () => {
  const manager = new WorkflowManager();
  manager.on("error", () => {});
  const runner = new EventedRunner({
    failWith: new WorkflowError("resumed runner failed", WorkflowErrorCode.SCRIPT_ERROR, {
      recoverable: false,
    }),
  });
  const { runId, context } = await createCheckpointPausedRun(manager, runner);
  const seen: AgentEventPayload[] = [];
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event));

  const accepted = await manager.resume(runId, {
    agent: eventedAgent(runner),
    checkpointReplies: { [context.callIndex]: "continue" },
  });

  assert.equal(accepted, true);
  await waitUntil(() => manager.getRun(runId)?.status === "failed", "resumed run should fail");
  await waitUntil(
    () => runner.listenerCount("session_update") === 0 && runner.listenerCount("session_open") === 0,
    "the bridge should release after the failed resume settles",
  );
  assert.equal(manager.getRun(runId)?.error?.code, WorkflowErrorCode.SCRIPT_ERROR);

  const forwardedBeforePostSettlementEvent = seen.length;
  runner.emit("session_open", { sessionId: "after-failed-resume", backendId: runner.backendId, runId });
  assert.equal(
    seen.length,
    forwardedBeforePostSettlementEvent,
    "runner events are not forwarded after the failed resume settles",
  );
});

test("WorkflowManager.resume releases the exec runner bridge when the resumed run is stopped", async () => {
  const manager = new WorkflowManager();
  manager.on("error", () => {});
  const gate = deferred();
  let gateEntered = false;
  const runner = new EventedRunner({
    waitForRun: () => {
      gateEntered = true;
      return gate.promise;
    },
  });
  const { runId, context } = await createCheckpointPausedRun(manager, runner);
  const seen: AgentEventPayload[] = [];
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event));

  const accepted = await manager.resume(runId, {
    agent: eventedAgent(runner),
    checkpointReplies: { [context.callIndex]: "continue" },
  });
  assert.equal(accepted, true);
  await waitUntil(() => gateEntered, "the resumed agent should block on its gate");
  assert.equal(runner.listenerCount("session_update"), 1, "the live resume retains its bridge");
  assert.equal(runner.listenerCount("session_open"), 1);

  assert.equal(manager.stop(runId), true);
  assert.equal(manager.getRun(runId)?.status, "aborted");
  assert.equal(runner.listenerCount("session_update"), 1, "the in-flight runner still owns the bridge");
  gate.resolve();

  await waitUntil(
    () => manager.getRun(runId)?.error?.code === WorkflowErrorCode.WORKFLOW_ABORTED,
    "the stopped resumed execution should settle as aborted",
  );
  await waitUntil(
    () => runner.listenerCount("session_update") === 0 && runner.listenerCount("session_open") === 0,
    "the bridge should release after the stopped resume settles",
  );

  const forwardedBeforePostSettlementEvent = seen.length;
  runner.emit("session_open", { sessionId: "after-stopped-resume", backendId: runner.backendId, runId });
  assert.equal(
    seen.length,
    forwardedBeforePostSettlementEvent,
    "runner events are not forwarded after the stopped resume settles",
  );
});

test("WorkflowManager.resume releases an exec runner bridge immediately when resume is rejected", async () => {
  const manager = new WorkflowManager();
  const runner = new EventedRunner();
  const seen: AgentEventPayload[] = [];
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event));

  const accepted = await manager.resume("unknown-run-id", { agent: eventedAgent(runner) });

  assert.equal(accepted, false);
  assert.equal(runner.listenerCount("session_update"), 0);
  assert.equal(runner.listenerCount("session_open"), 0);
  runner.emit("session_open", { sessionId: "rejected", backendId: runner.backendId });
  assert.deepEqual(seen, [], "a rejected resume leaves no forwarding subscription behind");
});

test("WorkflowManager.resumeInBackground shares one bridge across overlapping resumes and releases every ref", async () => {
  const manager = new WorkflowManager();
  const firstRunId = await createResumableRun(manager);
  const secondRunId = await createResumableRun(manager);
  const gates: Array<ReturnType<typeof deferred>> = [];
  const runner = new EventedRunner({
    waitForRun: () => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
  });
  const agent = eventedAgent(runner);
  const seen: AgentEventPayload[] = [];
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event));

  const first = await manager.resumeInBackground(firstRunId, { agent });
  if (!first.accepted) assert.fail("first paused run should resume");
  await waitUntil(() => gates.length === 1, "first resume should reach the runner");

  const duplicate = await manager.resumeInBackground(firstRunId, { agent });
  assert.deepEqual(duplicate, { accepted: false }, "an already-running resume is rejected");
  assert.equal(runner.listenerCount("session_update"), 1, "rejected overlap releases only its own ref");

  const second = await manager.resumeInBackground(secondRunId, { agent });
  if (!second.accepted) assert.fail("second paused run should resume");
  await waitUntil(() => gates.length === 2, "second resume should reach the runner");

  assert.equal(runner.listenerCount("session_update"), 1, "shared runner is subscribed once");
  assert.equal(runner.listenerCount("session_open"), 1);
  runner.emit("session_open", {
    sessionId: "overlapping-resumes",
    backendId: runner.backendId,
  });
  assert.equal(
    seen.filter((event) => event.name === "session_open" && event.sessionId === "overlapping-resumes").length,
    1,
    "one runner emission is forwarded exactly once during overlap",
  );

  gates[0]?.resolve();
  assert.equal((await first.promise).status, "completed");
  assert.equal(runner.listenerCount("session_update"), 1, "second accepted resume retains the shared bridge");

  gates[1]?.resolve();
  assert.equal((await second.promise).status, "completed");
  assert.equal(runner.listenerCount("session_update"), 0, "final settlement returns to the listener baseline");
  assert.equal(runner.listenerCount("session_open"), 0);
});

test("WorkflowManager agentEvent bridge unsubscribes on dispose", () => {
  const runner = new EventedRunner();
  const manager = new WorkflowManager({ agent: eventedAgent(runner) });
  const seen: string[] = [];
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event.name));

  assert.equal(runner.listenerCount("session_update"), 1);
  assert.equal(runner.listenerCount("session_open"), 1);

  manager.dispose();
  assert.equal(runner.listenerCount("session_update"), 0);
  assert.equal(runner.listenerCount("session_open"), 0);

  runner.emit("session_open", { sessionId: "after", backendId: "claude" });
  assert.deepEqual(seen, []);
});

test("WorkflowManager isolates throwing agentEvent listeners from sibling observers", () => {
  const runner = new EventedRunner();
  const manager = new WorkflowManager({ agent: eventedAgent(runner) });
  const seen: string[] = [];

  manager.on("agentEvent", () => {
    throw new Error("host listener failed");
  });
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event.name));

  assert.doesNotThrow(() => {
    runner.emit("session_open", { sessionId: "session-throw", backendId: "claude", label: "l", runId: "r" });
  });
  assert.deepEqual(seen, ["session_open"]);
});

// The gate behind every compile-gate above: actually type-check this suite. The build
// tsconfig.json is src-only and tsx never type-checks, so this spawned `tsc -p
// tsconfig.test.json` is the ONLY thing that makes a dropped/renamed facade re-export fail
// `pnpm test` (locally and in CI's `pnpm -r test`).
test("tsc type-checks the test suite (tsconfig.test.json) so the facade compile-gates are real", () => {
  const require = createRequire(import.meta.url);
  const tsc = require.resolve("typescript/lib/tsc.js");
  const pkgDir = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(process.execPath, [tsc, "-p", join(pkgDir, "tsconfig.test.json"), "--noEmit"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `tsc found type errors:\n${result.stdout}${result.stderr}`);
});
