import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });

  constructor(private readonly sessionId = "observe-session") {}

  on<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void {
    return this.bus.on(name, listener);
  }

  finish(): void {
    this.release();
  }

  async run(_prompt: string, options?: RunOptions): Promise<unknown> {
    const context: AcpEventContext = {
      sessionId: this.sessionId,
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
    const toolResult = {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "implementation body password=hunter2" } }],
      _meta: { adapter: { toolName: "read_file" } },
    } as AcpRunnerEventMap["session_update"]["update"];
    this.bus.emit("session_update", { ...context, update: toolResult });
    this.markStarted();
    await this.blocked;
    this.bus.emit("session_close", context);
    return "done";
  }
}

async function waitForChildOutput(child: ChildProcess, needle: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`child did not emit ${needle}; stdout=${stdout}; stderr=${stderr}`));
    }, 10_000);
    const settle = (callback: () => void) => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      callback();
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(needle)) settle(resolve);
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      settle(() => reject(new Error(
        `child exited before readiness: code=${code} signal=${signal}; stdout=${stdout}; stderr=${stderr}`,
      )));
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
  });
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
        records.filter((record) => record.event.type === "agentTranscript").length >= 3;
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
    assert.deepEqual(transcript.map((record) => record.event.type === "agentTranscript" ? record.event.entry.kind : ""), ["text", "toolCall", "toolResult"]);
    assert.equal(JSON.stringify(transcript).includes("hunter2"), false);
    const toolResultRecord = transcript.at(-1);
    assert.ok(toolResultRecord && toolResultRecord.event.type === "agentTranscript");
    assert.equal(toolResultRecord.event.entry.kind, "toolResult");
    assert.equal(toolResultRecord.event.entry.toolName, "read_file");
    assert.ok(toolResultRecord.event.entry.text.includes("[REDACTED]"));
    assert.equal(toolResultRecord.event.entry.isError, undefined);
  } finally {
    runner.finish();
    await started.promise;
    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("crash recovery and same-ID resume keep both live execution partitions readable", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentprism-live-observability-crash-cwd-"));
  const root = mkdtempSync(join(tmpdir(), "agentprism-live-observability-crash-runs-"));
  const runId = "observe-crash-resume";
  const script = [
    'export const meta = { name: "live-observability-crash", description: "crash resume" };',
    'return await agent("observe me", { label: "observer" });',
  ].join("\n");
  const fixture = join(import.meta.dirname, "fixtures", "live-observability-crash-child.ts");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fixture, cwd, root, runId, Buffer.from(script, "utf8").toString("base64url")],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const runner = new ControlledEventRunner("resumed-observe-session");
  let manager: WorkflowManager | undefined;
  let completion: Promise<unknown> | undefined;

  try {
    await waitForChildOutput(child, "LIVE_OBSERVABILITY_READY");
    const exited = once(child, "exit");
    assert.equal(child.kill("SIGKILL"), true);
    await exited;

    manager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      agent: runner as unknown as AgentRunner,
    });
    assert.equal(manager.inspectRun(runId)?.status, "paused");
    const resumed = await manager.resumeInBackground(runId);
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("same-ID crash resume should be accepted");
    completion = resumed.promise;
    await runner.started;

    const persistence = manager.getPersistence();
    const midFlight = persistence.readEvents(runId, { limit: 1_000 });
    const starts = midFlight.events.filter((record) => record.event.type === "agentStart");
    assert.equal(starts.length, 2);
    const firstStartSeq = starts[0]!.seq;
    const resumedStartSeq = starts[1]!.seq;
    assert.notEqual(firstStartSeq, resumedStartSeq);
    assert.equal(midFlight.events.some((record) => record.event.type === "agentEnd"), false);

    const liveRecords = midFlight.events.filter((record) =>
      record.event.type === "agentProgress" || record.event.type === "agentTranscript");
    const executionStarts = liveRecords.map((record) =>
      record.event.type === "agentProgress" || record.event.type === "agentTranscript"
        ? record.event.executionStartSeq
        : 0);
    assert.ok(executionStarts.includes(firstStartSeq));
    assert.ok(executionStarts.includes(resumedStartSeq));
    const resumedTranscript = liveRecords.find((record) =>
      record.event.type === "agentTranscript" && record.event.executionStartSeq === resumedStartSeq);
    const resumedProgress = liveRecords.find((record) =>
      record.event.type === "agentProgress" && record.event.executionStartSeq === resumedStartSeq);
    assert.ok(resumedTranscript?.event.type === "agentTranscript");
    assert.equal(resumedTranscript.event.entryIndex, 0);
    assert.equal(resumedTranscript.event.revision, 0);
    assert.ok(resumedProgress?.event.type === "agentProgress");
    assert.equal(resumedProgress.event.turnCount, 1);

    const stream = persistence.watchEvents(runId, {
      after: resumedStartSeq,
      streamId: midFlight.streamId,
    });
    try {
      const firstResumedLiveRecord = (await stream.next()).value;
      assert.equal(firstResumedLiveRecord?.event.type, "agentTranscript");
      assert.equal(
        firstResumedLiveRecord?.event.type === "agentTranscript"
          ? firstResumedLiveRecord.event.executionStartSeq
          : undefined,
        resumedStartSeq,
      );
    } finally {
      stream.close();
    }

    runner.finish();
    const result = await resumed.promise;
    assert.equal(result.status, "completed");
    assert.equal(persistence.readEvents(runId, { limit: 1_000 }).events.at(-1)?.event.type, "complete");
  } finally {
    runner.finish();
    await completion?.catch(() => {});
    manager?.dispose();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => {});
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
