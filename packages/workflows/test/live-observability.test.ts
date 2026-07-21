import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AcpEventContext,
  AcpEventListener,
  AcpEventName,
  AcpRunnerEventMap,
  AgentRunner,
  RunOptions,
} from "../src/index.js";
import { TypedEventEmitter, WorkflowManager } from "../src/index.js";

class ControlledEventRunner {
  private readonly bus = new TypedEventEmitter<AcpRunnerEventMap>();
  private release!: () => void;
  private readonly blocked = new Promise<void>((resolve) => { this.release = resolve; });

  on<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void {
    return this.bus.on(name, listener);
  }

  finish(): void {
    this.release();
  }

  async run(_prompt: string, options?: RunOptions): Promise<unknown> {
    const context: AcpEventContext = {
      sessionId: "observe-session",
      backendId: "claude",
      label: options?.label,
      runId: options?.runId,
      callIndex: options?.callIndex,
    };
    this.bus.emit("session_open", context);
    const text = {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-1",
      content: { type: "text", text: `${"🙂".repeat(160)} password=hunter2` },
    } as AcpRunnerEventMap["session_update"]["update"];
    this.bus.emit("session_update", { ...context, update: text });
    const tool = {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read the implementation",
      kind: "read",
      _meta: { adapter: { toolName: "read_file" } },
    } as AcpRunnerEventMap["session_update"]["update"];
    this.bus.emit("session_update", { ...context, update: tool });
    await this.blocked;
    this.bus.emit("session_close", context);
    return "done";
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for in-flight observability records");
}

test("content-bearing progress and transcript records are durable before agent settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-live-observability-"));
  const runner = new ControlledEventRunner();
  const manager = new WorkflowManager({ agent: runner as unknown as AgentRunner, persistenceRoot: root });
  const script = [
    'export const meta = { name: "live-observability", description: "in flight" };',
    'return await agent("observe me", { label: "observer" });',
  ].join("\n");
  const started = manager.startInBackground(script, undefined, { runId: "observe-run" });
  try {
    let records = manager.getPersistence().readEvents(started.runId, { limit: 100 }).events;
    await waitUntil(() => {
      records = manager.getPersistence().readEvents(started.runId, { limit: 100 }).events;
      return records.some((record) => record.event.type === "agentProgress") &&
        records.filter((record) => record.event.type === "agentTranscript").length >= 2;
    });

    assert.equal(records.some((record) => record.event.type === "agentEnd"), false);
    const progress = records.find((record) => record.event.type === "agentProgress");
    assert.ok(progress && progress.event.type === "agentProgress");
    assert.equal(progress.event.callIndex, 0);
    assert.equal(progress.event.label, "observer");
    assert.equal(progress.event.turnCount, 1);
    assert.ok(progress.event.latestText?.includes("[REDACTED]"));
    assert.equal(JSON.stringify(progress).includes("hunter2"), false);
    assert.ok(Buffer.byteLength(progress.event.latestText ?? "", "utf8") <= 512);

    const transcript = records.filter((record) => record.event.type === "agentTranscript");
    assert.deepEqual(transcript.map((record) => record.event.type === "agentTranscript" ? record.event.entry.kind : ""), ["text", "toolCall"]);
    assert.equal(JSON.stringify(transcript).includes("hunter2"), false);
  } finally {
    runner.finish();
    await started.promise;
    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
