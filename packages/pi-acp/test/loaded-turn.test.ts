// The `_session/loaded_turn` extension (the REPL broker's re-attach arm's
// authoritative completion evidence): the query answers whether the loaded
// session's founding turn is still running right now — `completed` when
// the session journal's last message entry is an assistant message (pi
// persists every complete LLM message atomically at message_end, so the
// replay's trailing assistant message is the turn's FINAL message),
// `interrupted` when the journal shows an interrupted/abandoned turn, and
// `running` while a turn executes in-process (with the
// `_session/loaded_turn/ended` push when that turn ends, carrying its
// stop reason or its error).
import assert from "node:assert/strict";
import test from "node:test";
import { client, methods } from "@agentclientprotocol/sdk";
import { PiAcpAgent } from "../src/agent.js";
import { runAcp } from "../src/server.js";
import { context, fakeDeps, streamPair } from "./helpers/fakes.js";
import {
  LOADED_TURN_QUERY_METHOD,
  LOADED_TURN_ENDED_METHOD,
  type LoadedTurnQueryResponse,
  type LoadedTurnQueryRequest,
} from "../src/loaded-turn.js";

async function eventually(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error("eventually: condition not met in time");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

test("loadedTurnStatus classifies the journal: a completed turn leaves an assistant leaf (completed); an interrupted/empty journal is interrupted; a live turn is running", async () => {
  const setup = fakeDeps("wedged");
  const agent = new PiAcpAgent(setup.deps);
  try {
    // A completed turn: the journal's last message entry is the assistant
    // message — the authoritative `completed` classification (the replay's
    // trailing assistant message is the founding turn's FINAL message;
    // pi persists every complete LLM message atomically at message_end,
    // so the leaf is the ground truth a crash would leave behind).
    const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
    const session = agent["live"].get(opened.sessionId)!;
    session.manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "task" }],
      timestamp: Date.now(),
    } as never);
    session.manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "result B" }],
      stopReason: "end_turn",
      timestamp: Date.now(),
    } as never);
    assert.equal(session.loadedTurnStatus(), "completed");

    // An interrupted turn (the journal ends at the user message — the
    // process died mid-turn): nothing is running, so the honest answer is
    // `interrupted` (re-issue is safe).
    const opened2 = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
    const session2 = agent["live"].get(opened2.sessionId)!;
    session2.manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "task" }],
      timestamp: Date.now(),
    } as never);
    assert.equal(session2.loadedTurnStatus(), "interrupted");

    // An empty journal (never started): `interrupted` too.
    const opened3 = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
    assert.equal(agent["live"].get(opened3.sessionId)!.loadedTurnStatus(), "interrupted");

    // A turn executing in-process right now answers `running`.
    const opened4 = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
    const prompt = agent.prompt(context({
      sessionId: opened4.sessionId,
      prompt: [{ type: "text", text: "live" }],
    }));
    await eventually(() => assert.ok(setup.controls[3]?.resolvePrompt));
    assert.equal(agent["live"].get(opened4.sessionId)!.loadedTurnStatus(), "running");
    setup.controls[3]!.resolvePrompt?.();
    assert.equal((await prompt).stopReason, "end_turn");
  } finally {
    await agent.dispose();
  }
});

test("a turn executing in-process answers `running`, and its finish pushes the authoritative _session/loaded_turn/ended notification (stop reason)", async () => {
  const setup = fakeDeps("wedged");
  const pair = streamPair();
  const app = client({ name: "pi-acp-loaded-turn-wire" })
    .onNotification(
      LOADED_TURN_ENDED_METHOD,
      (params: unknown) => (params ?? {}) as Record<string, unknown>,
      ({ params }) => {
        ended.push(params as { sessionId: string; stopReason?: string; error?: { name: string; message: string } });
      },
    );
  const ended: Array<{ sessionId: string; stopReason?: string; error?: { name: string; message: string } }> = [];
  const server = await runAcp({ deps: setup.deps, stream: pair.agent });
  const connection = app.connect(pair.client);
  try {
    const initialized = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
    });
    assert.deepEqual(initialized._meta, { steering: { supported: true }, loadedTurn: { supported: true } });

    const opened = await connection.agent.request(methods.agent.session.new, {
      cwd: setup.cwd,
      mcpServers: [],
    });
    const prompt = connection.agent.request(methods.agent.session.prompt, {
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "original" }],
    });
    await eventually(() => assert.ok(setup.controls[0]?.resolvePrompt));

    // The turn is executing: the query answers `running` (the client then
    // waits for the ended push).
    assert.deepEqual(
      await connection.agent.request<LoadedTurnQueryResponse, LoadedTurnQueryRequest>(
        LOADED_TURN_QUERY_METHOD,
        { sessionId: opened.sessionId },
      ),
      { status: "running" },
    );

    // The turn ends with a response: the ended notification carries the
    // stop reason (the authoritative terminal marker the re-attach arm
    // waits on).
    setup.controls[0]?.resolvePrompt?.();
    assert.equal((await prompt).stopReason, "end_turn");
    await eventually(() => assert.equal(ended.length, 1));
    assert.deepEqual(ended[0], { sessionId: opened.sessionId, stopReason: "end_turn" });
  } finally {
    await server.connection.close();
  }
});
