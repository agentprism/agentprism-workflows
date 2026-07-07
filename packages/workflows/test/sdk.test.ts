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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  RunPersistenceOptions,
  WorkflowPathOptions,
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

  constructor(options: { waitForRun?: () => Promise<void> } = {}) {
    this.waitForRun = options.waitForRun;
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
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
  assert.equal(runPersistenceOptions.persistenceRoot, pathOptions.persistenceRoot);
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
