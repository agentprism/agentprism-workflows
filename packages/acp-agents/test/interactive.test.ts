// Focused non-spawning checks for the public interactive session surface: option validation,
// prompt-time image validation, and the one-turn-at-a-time host contract.
import test from "node:test";
import assert from "node:assert/strict";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import type { Backend } from "../src/backend.js";
import type {
  PooledConnection,
  SessionHandle,
  SteeringOutcome,
} from "../src/acp-client.js";
import { AcpAgentRunner, InteractiveSession } from "../src/index.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeInteractive(
  session: Partial<SessionHandle>,
  options: {
    schema?: unknown;
    backend?: Partial<Backend>;
  } = {},
): InteractiveSession {
  return new InteractiveSession({
    session: {
      sessionId: "unit-session",
      currentTurnText: () => "",
      prompt: async () => ({ stopReason: "end_turn" }),
      steer: async () => "injected",
      cancel: async () => undefined,
      release: async () => undefined,
      ...session,
    } as unknown as SessionHandle,
    connection: {
      backendId: "claude",
      capabilities: undefined,
      dispose: async () => undefined,
    } as unknown as PooledConnection,
    backend: {
      id: "claude",
      spawnConfig: () => ({ command: "node", args: [], env: process.env }),
      sessionMeta: () => undefined,
      promptMeta: () => undefined,
      nativeStructured: () => undefined,
      ...options.backend,
    } as Backend,
    subscribe: () => () => undefined,
    onRelease: () => undefined,
    schema: options.schema as never,
  });
}

test("openSession rejects a relative cwd before spawning", async () => {
  const runner = new AcpAgentRunner();
  try {
    await assert.rejects(
      () => runner.openSession({ cwd: "relative/path", label: "interactive-agent" }),
      (err: unknown) => {
        assert.ok(isWorkflowError(err));
        assert.equal(err.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.equal(err.recoverable, false);
        assert.equal(err.agentLabel, "interactive-agent");
        assert.match(err.message, /cwd.+absolute path/);
        return true;
      },
    );
  } finally {
    await runner.dispose();
  }
});

test("InteractiveSession.prompt rejects a second in-flight turn", async () => {
  const gate = deferred<void>();
  let calls = 0;
  const session = fakeInteractive({
    prompt: async () => {
      calls += 1;
      await gate.promise;
      return { stopReason: "end_turn" };
    },
    currentTurnText: () => "first",
  });

  const first = session.prompt("one");
  await assert.rejects(
    () => session.prompt("two"),
    /InteractiveSession\.prompt\(\) already has a prompt in flight/,
  );
  gate.resolve();

  assert.deepEqual(await first, { stopReason: "end_turn", text: "first" });
  assert.equal(calls, 1);
});

test("InteractiveSession.prompt validates per-turn images before sending", async () => {
  let sent = false;
  const session = fakeInteractive({
    prompt: async () => {
      sent = true;
      return { stopReason: "end_turn" };
    },
  });

  await assert.rejects(
    () => session.prompt("look", { images: [{ data: "", mimeType: "image/png" }] }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.match(err.message, /images\[0\]\.data/);
      return true;
    },
  );
  assert.equal(sent, false);
});

test("InteractiveSession.steer rejects idle callers and directs them to prompt()", async () => {
  let sent = false;
  const session = fakeInteractive({
    steer: async () => {
      sent = true;
      return "injected";
    },
  });

  await assert.rejects(
    () => session.steer("follow up"),
    /steer\(\) requires prompt\(\) to be in flight; use prompt\(\) when the session is idle/,
  );
  assert.equal(sent, false);
});

test("InteractiveSession.steer adapts images/meta and surfaces every outcome unchanged", async () => {
  const promptGate = deferred<void>();
  const outcomes: SteeringOutcome[] = ["injected", "startedNewTurn", "failed"];
  const calls: Array<{
    content: Parameters<SessionHandle["steer"]>[0];
    meta: Record<string, unknown> | undefined;
  }> = [];
  const session = fakeInteractive({
    prompt: async () => {
      await promptGate.promise;
      return { stopReason: "end_turn" };
    },
    steer: async (content, meta) => {
      calls.push({ content, meta });
      return outcomes[calls.length - 1]!;
    },
  });
  const prompt = session.prompt("original");

  const image = { data: "ZmFrZQ==", mimeType: "image/png", uri: "file:///tmp/fake.png" };
  assert.equal(
    await session.steer("redirect", { images: [image], promptMeta: { private: "request-only" } }),
    "injected",
  );
  assert.equal(await session.steer("late"), "startedNewTurn");
  assert.equal(await session.steer("declined"), "failed");
  assert.deepEqual(calls[0], {
    content: [
      { type: "text", text: "redirect" },
      { type: "image", ...image },
    ],
    meta: { private: "request-only" },
  });

  promptGate.resolve();
  await prompt;
});

test("InteractiveSession.prompt merges the backend's schema channel UNDER the user turn meta", async () => {
  const schema = { type: "object", properties: { answer: { type: "string" } } };
  const SCHEMA_KEY = "outputSchema";
  const sent: Array<Record<string, unknown> | undefined> = [];
  const session = fakeInteractive(
    {
      prompt: async (_content, meta) => {
        sent.push(meta as Record<string, unknown> | undefined);
        return { stopReason: "end_turn" };
      },
    },
    {
      schema,
      backend: {
        id: "codex",
        promptMeta: (s) => (s ? { [SCHEMA_KEY]: s } : undefined),
      },
    },
  );

  await session.prompt("task", { promptMeta: { trace: "user-1" } });
  assert.deepEqual(sent, [{ trace: "user-1", [SCHEMA_KEY]: schema }]);
  // Without user meta the backend channel alone travels.
  await session.prompt("task");
  assert.deepEqual(sent[1], { [SCHEMA_KEY]: schema });
  // A user key never clobbers the schema channel (backend-computed keys merge over).
  await session.prompt("task", { promptMeta: { [SCHEMA_KEY]: "user-clobber" } });
  assert.deepEqual(sent[2], { [SCHEMA_KEY]: schema });
});

test("InteractiveSession.prompt embeds the schema contract in the prompt for embedSchemaInPrompt backends", async () => {
  const schema = { type: "object", properties: { answer: { type: "string" } } };
  const sent: Array<string | import("@agentclientprotocol/sdk").ContentBlock[]> = [];
  const session = fakeInteractive(
    {
      prompt: async (content) => {
        sent.push(content);
        return { stopReason: "end_turn" };
      },
    },
    {
      schema,
      backend: {
        id: "custom",
        embedSchemaInPrompt: true,
        promptMeta: () => undefined,
      },
    },
  );

  await session.prompt("research X");
  assert.equal(sent.length, 1);
  const text = typeof sent[0] === "string" ? sent[0] : "";
  assert.ok(text.includes("research X"), text);
  assert.ok(text.includes("Final output contract"), text);
  assert.ok(text.includes(JSON.stringify(schema)), "the schema is stated in-band");
  // ContentBlock prompts are left untouched (the host owns their shaping).
  const blocks = [{ type: "text" as const, text: "verbatim" }];
  await session.prompt(blocks);
  assert.deepEqual(sent[1], blocks);
  // A backend WITHOUT embedSchemaInPrompt keeps the prompt verbatim (the native channel is authoritative).
  const plain = fakeInteractive(
    {
      prompt: async (content) => {
        sent.push(content);
        return { stopReason: "end_turn" };
      },
    },
    { schema, backend: { id: "claude", promptMeta: () => undefined } },
  );
  await plain.prompt("research X");
  assert.equal(sent[2], "research X");
});

test("InteractiveSession.outputSchema exposes the session's contract", () => {
  const schema = { type: "object", properties: { n: { type: "number" } } };
  const session = fakeInteractive({}, { schema });
  assert.equal(session.outputSchema, schema);
  assert.equal(fakeInteractive({}).outputSchema, undefined);
});

test("InteractiveSession does not serialize concurrent steer calls", async () => {
  const promptGate = deferred<void>();
  const firstGate = deferred<SteeringOutcome>();
  const secondGate = deferred<SteeringOutcome>();
  const seen: string[] = [];
  const session = fakeInteractive({
    prompt: async () => {
      await promptGate.promise;
      return { stopReason: "end_turn" };
    },
    steer: async (content) => {
      const text = typeof content === "string" ? content : "";
      seen.push(text);
      return text === "first" ? firstGate.promise : secondGate.promise;
    },
  });
  const prompt = session.prompt("original");

  const first = session.steer("first");
  const second = session.steer("second");
  assert.deepEqual(seen, ["first", "second"], "both requests reached the backend without a client queue");
  secondGate.resolve("failed");
  assert.equal(await second, "failed", "the second request may settle before the first");
  firstGate.resolve("injected");
  assert.equal(await first, "injected");

  promptGate.resolve();
  await prompt;
});
