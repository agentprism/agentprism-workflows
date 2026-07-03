// Focused non-spawning checks for the public interactive session surface: option validation,
// prompt-time image validation, and the one-turn-at-a-time host contract.
import test from "node:test";
import assert from "node:assert/strict";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import type { Backend } from "../src/backend.js";
import type { PooledConnection, SessionHandle } from "../src/acp-client.js";
import { AcpAgentRunner, InteractiveSession } from "../src/index.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeInteractive(session: Partial<SessionHandle>): InteractiveSession {
  return new InteractiveSession({
    session: {
      sessionId: "unit-session",
      currentTurnText: () => "",
      prompt: async () => ({ stopReason: "end_turn" }),
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
    } as Backend,
    subscribe: () => () => undefined,
    onRelease: () => undefined,
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
