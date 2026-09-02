import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import test from "node:test";

import type { AgentRunner, RunOptions } from "@automatalabs/shared-types";
import type {
  AcpEventContext,
  AcpEventListener,
  AcpEventName,
  AcpRunnerEventMap,
} from "@automatalabs/workflows";
import { TypedEventEmitter } from "@automatalabs/workflows";

import {
  connect,
  NO_AGENT_SCRIPT,
  okRunner,
  persistedRunFile,
  structured,
  type ToolCallResult,
} from "./_harness.js";

interface LatestActivity {
  scope: string;
  callIndex: number;
  executionStartSeq: number;
  label: string;
  phase?: string;
  timestamp: string;
  cursor: number;
  turnCount: number;
  observedEvents: number;
  latestText?: string;
  lastToolName?: string;
  tokensObserved?: number;
  relevance: "current" | "terminal";
}

function runIdOf(result: ToolCallResult): string {
  const runId = structured(result)?.runId;
  assert.equal(typeof runId, "string");
  return runId;
}

function activityOf(result: ToolCallResult): LatestActivity[] | undefined {
  return structured(result)?.latestActivity as LatestActivity[] | undefined;
}

function resourceLinks(result: ToolCallResult): Array<Record<string, unknown>> {
  return (result.content as Array<Record<string, unknown>>).filter((block) => block.type === "resource_link");
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

class BlockingActivityRunner {
  private readonly bus = new TypedEventEmitter<AcpRunnerEventMap>();
  private readonly startedCalls = new Set<number>();
  readonly calls: Array<{ finish: () => void }> = [];

  on<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void {
    return this.bus.on(name, listener);
  }

  listBackends(): string[] {
    return ["claude", "codex", "opencode", "pi"];
  }

  async probeConfigOptions(): Promise<{ backendId: string; options: [] }> {
    return { backendId: "claude", options: [] };
  }

  hasStarted(callIndex: number): boolean {
    return this.startedCalls.has(callIndex);
  }

  async run(_prompt: string, options?: RunOptions): Promise<unknown> {
    const callIndex = options?.callIndex ?? this.calls.length;
    const context: AcpEventContext = {
      sessionId: `activity-session-${callIndex}`,
      backendId: "claude",
      label: options?.label,
      runId: options?.runId,
      callIndex,
    };
    this.bus.emit("session_open", context);
    this.bus.emit("session_update", {
      ...context,
      update: { sessionUpdate: "usage_update", used: 77, size: 100 },
    });
    this.bus.emit("session_update", {
      ...context,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: `message-${callIndex}`,
        content: { type: "text", text: `${"🙂".repeat(180)} password=hunter2` },
      },
    });
    this.bus.emit("session_update", {
      ...context,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `tool-${callIndex}`,
        title: "Read the implementation",
        kind: "read",
        _meta: { adapter: { toolName: "read_file" } },
      },
    });
    this.startedCalls.add(callIndex);

    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const close = () => {
        if (settled) return false;
        settled = true;
        this.bus.emit("session_close", context);
        return true;
      };
      const finish = () => {
        if (close()) resolve(`done-${callIndex}`);
      };
      this.calls.push({ finish });
      options?.signal?.addEventListener("abort", () => {
        if (!close()) return;
        const error = new Error("cancelled by lifecycle test");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  }
}

class ImmediateActivityRunner {
  private readonly bus = new TypedEventEmitter<AcpRunnerEventMap>();

  on<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void {
    return this.bus.on(name, listener);
  }

  listBackends(): string[] {
    return ["claude", "codex", "opencode", "pi"];
  }

  async probeConfigOptions(): Promise<{ backendId: string; options: [] }> {
    return { backendId: "claude", options: [] };
  }

  async run(_prompt: string, options?: RunOptions): Promise<unknown> {
    const callIndex = options?.callIndex ?? 0;
    const context: AcpEventContext = {
      sessionId: `bulk-session-${callIndex}`,
      backendId: "claude",
      label: options?.label,
      runId: options?.runId,
      callIndex,
    };
    this.bus.emit("session_open", context);
    this.bus.emit("session_update", {
      ...context,
      update: { sessionUpdate: "usage_update", used: callIndex + 1, size: 100 },
    });
    this.bus.emit("session_update", {
      ...context,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: `bulk-message-${callIndex}`,
        content: { type: "text", text: `${"😀".repeat(300)} token=super-secret-${callIndex}` },
      },
    });
    this.bus.emit("session_close", context);
    return { callIndex };
  }
}

test("status exposes live redacted activity and retains terminal activity after targeted cancellation and restart", async () => {
  const runner = new BlockingActivityRunner();
  const first = await connect(runner as unknown as AgentRunner, { listTools: true });
  let runId: string | undefined;
  try {
    const accepted = await first.client.callTool({
      name: "workflow",
      arguments: {
        background: true,
        script: [
          'export const meta = { name: "activity-cancel", description: "targeted cancellation" };',
          'return await agent("hold", { label: "active-review" });',
        ].join("\n"),
      },
    });
    runId = runIdOf(accepted);
    const eventsUri = `workflow://runs/${runId}/events`;
    assert.equal(structured(accepted)?.eventsUri, eventsUri);
    const acceptedEventLink = resourceLinks(accepted).find((link) => link.uri === eventsUri);
    assert.match(String(acceptedEventLink?.name), /events/i);
    assert.match(String(acceptedEventLink?.description), /event stream/i);

    await waitUntil(() => runner.hasStarted(0), "the activity-producing call should start");
    const live = await first.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId, waitMs: 0 },
    });
    const liveActivity = activityOf(live);
    assert.equal(liveActivity?.length, 1);
    assert.equal(liveActivity?.[0]?.relevance, "current");
    assert.equal(liveActivity?.[0]?.turnCount, 1);
    assert.equal(liveActivity?.[0]?.observedEvents, 2);
    assert.equal(liveActivity?.[0]?.tokensObserved, 77);
    assert.ok(liveActivity?.[0]?.latestText?.includes("[REDACTED]"));
    assert.equal(JSON.stringify(live).includes("hunter2"), false);
    assert.ok(Buffer.byteLength(liveActivity?.[0]?.latestText ?? "", "utf8") <= 512);
    assert.ok((liveActivity?.[0]?.cursor ?? 0) > 0);
    assert.match(liveActivity?.[0]?.timestamp ?? "", /^\d{4}-\d{2}-\d{2}T/);

    const cancelled = await first.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId, callIndex: 0 },
    });
    assert.equal(cancelled.isError, false);
    const cancelledActivity = activityOf(cancelled);
    assert.equal(cancelledActivity?.[0]?.relevance, "terminal");
    assert.equal(cancelledActivity?.[0]?.lastToolName, "read_file");
    assert.equal(cancelledActivity?.[0]?.observedEvents, 3);

    const terminal = await first.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId, waitMs: 1_000 },
    });
    assert.equal(structured(terminal)?.status, "completed");
    assert.equal(activityOf(terminal)?.[0]?.relevance, "terminal");
    assert.equal((structured(terminal)?.outcome as Record<string, unknown>).eventsUri, eventsUri);
  } finally {
    for (const call of runner.calls) call.finish();
    await first.dispose();
  }

  assert.ok(runId);
  const cold = await connect(okRunner());
  try {
    const persisted = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId, waitMs: 0 },
    });
    assert.equal(structured(persisted)?.eventsUri, `workflow://runs/${runId}/events`);
    assert.equal(activityOf(persisted)?.[0]?.relevance, "terminal");
    assert.equal(activityOf(persisted)?.[0]?.lastToolName, "read_file");
    assert.equal(JSON.stringify(persisted).includes("hunter2"), false);
  } finally {
    await cold.dispose();
  }
});

test("whole-run abort preserves the last activity as terminal", async () => {
  const runner = new BlockingActivityRunner();
  const connection = await connect(runner as unknown as AgentRunner);
  try {
    const accepted = await connection.client.callTool({
      name: "workflow",
      arguments: {
        background: true,
        script: [
          'export const meta = { name: "activity-abort", description: "whole abort" };',
          'return await agent("hold", { label: "abort-review" });',
        ].join("\n"),
      },
    });
    const runId = runIdOf(accepted);
    await waitUntil(() => runner.hasStarted(0), "the abort target should start");
    const stopped = await connection.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId },
    });
    assert.equal(structured(stopped)?.status, "aborted");
    assert.equal(structured(stopped)?.eventsUri, `workflow://runs/${runId}/events`);
    assert.equal(activityOf(stopped)?.[0]?.relevance, "terminal");
    assert.equal(activityOf(stopped)?.[0]?.lastToolName, "read_file");

    const status = await connection.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId, waitMs: 0 },
    });
    assert.equal(structured(status)?.status, "aborted");
    assert.equal(activityOf(status)?.[0]?.relevance, "terminal");
  } finally {
    for (const call of runner.calls) call.finish();
    await connection.dispose();
  }
});

test("latest activity participates in the existing structured byte cap", async () => {
  const runner = new ImmediateActivityRunner();
  const connection = await connect(runner as unknown as AgentRunner);
  try {
    const calls = Array.from(
      { length: 50 },
      (_, index) => `() => agent("work-${index}", { label: "activity-${String(index).padStart(2, "0")}" })`,
    ).join(",\n");
    const completed = await connection.client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "activity-cap", description: "bounded activity" };',
          `return await parallel([${calls}]);`,
        ].join("\n"),
      },
    });
    const runId = runIdOf(completed);
    const status = await connection.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId, waitMs: 0, lastN: 50, logLines: 50 },
    });
    const payload = structured(status)!;
    const latestActivity = activityOf(status) ?? [];
    const { outcome: _outcome, tokenUsage: _tokenUsage, wait: _wait, ...boundedStatus } = payload;
    assert.ok(Buffer.byteLength(JSON.stringify(boundedStatus), "utf8") <= 24_576);
    assert.equal((payload.truncation as Record<string, unknown>).byteCapApplied, true);
    assert.ok(latestActivity.length > 0 && latestActivity.length < 50);
    assert.ok(latestActivity.every((item) => item.relevance === "terminal"));
    assert.ok(latestActivity.every((item) => Buffer.byteLength(item.latestText ?? "", "utf8") <= 512));
    assert.equal(JSON.stringify(latestActivity).includes("super-secret"), false);
    assert.deepEqual(
      latestActivity.map((item) => item.cursor),
      [...latestActivity.map((item) => item.cursor)].sort((left, right) => left - right),
    );
  } finally {
    await connection.dispose();
  }
});

test("legacy persisted rows omit events discovery and latest activity without breaking status", async () => {
  const first = await connect(okRunner());
  let runId: string | undefined;
  let runFile: string | undefined;
  try {
    const completed = await first.client.callTool({
      name: "workflow",
      arguments: { script: NO_AGENT_SCRIPT },
    });
    runId = runIdOf(completed);
    runFile = persistedRunFile(runId);
    assert.ok(runFile);
  } finally {
    await first.dispose();
  }

  assert.ok(runId && runFile);
  const row = JSON.parse(readFileSync(runFile, "utf8")) as Record<string, unknown>;
  delete row.eventStreamId;
  delete row.eventSeq;
  delete row.eventLogIncomplete;
  writeFileSync(runFile, `${JSON.stringify(row, null, 2)}\n`, "utf8");
  try {
    unlinkSync(runFile.replace(/\.json$/, ".events.jsonl"));
  } catch {
    // The zero-event legacy fixture may not have materialized a sidecar.
  }

  const cold = await connect(okRunner());
  try {
    const status = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId, waitMs: 0 },
    });
    assert.equal(status.isError, false);
    assert.equal(structured(status)?.status, "completed");
    assert.equal(structured(status)?.eventsUri, undefined);
    assert.equal(activityOf(status), undefined);
    assert.equal((structured(status)?.outcome as Record<string, unknown>).eventsUri, undefined);
    assert.equal(
      resourceLinks(status).some((link) => String(link.uri).endsWith("/events")),
      false,
    );
  } finally {
    await cold.dispose();
  }
});

test("an eventLogIncomplete stream omits events discovery and latest activity without breaking status", async () => {
  const first = await connect(okRunner());
  let runId: string | undefined;
  let runFile: string | undefined;
  try {
    const completed = await first.client.callTool({
      name: "workflow",
      arguments: { script: NO_AGENT_SCRIPT },
    });
    runId = runIdOf(completed);
    runFile = persistedRunFile(runId);
    assert.ok(runFile);
    // Before the fault marker is set, the completed run advertises its durable events stream.
    assert.equal(typeof structured(completed)?.eventsUri, "string");
  } finally {
    await first.dispose();
  }

  assert.ok(runId && runFile);
  // A mid-run journal-append fault leaves a valid stream id/watermark but an incomplete log whose
  // read/watch seam fails closed; the events surfaces must treat it as integrity-unsafe and omit it
  // rather than advertise a URI/link that would fault (EVENT_LOG_INCOMPLETE) on read.
  const row = JSON.parse(readFileSync(runFile, "utf8")) as Record<string, unknown>;
  assert.equal(typeof row.eventStreamId, "string");
  assert.equal(Number.isSafeInteger(row.eventSeq), true);
  row.eventLogIncomplete = true;
  writeFileSync(runFile, `${JSON.stringify(row, null, 2)}\n`, "utf8");

  const cold = await connect(okRunner());
  try {
    const status = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId, waitMs: 0 },
    });
    assert.equal(status.isError, false);
    assert.equal(structured(status)?.status, "completed");
    assert.equal(structured(status)?.eventsUri, undefined);
    assert.equal(activityOf(status), undefined);
    assert.equal((structured(status)?.outcome as Record<string, unknown>).eventsUri, undefined);
    assert.equal(
      resourceLinks(status).some((link) => String(link.uri).endsWith("/events")),
      false,
    );

    // The immutable result stays retrievable even though the events sidecar is unadvertised.
    const result = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "result", runId },
    });
    assert.equal(result.isError, false);
    assert.equal(structured(result)?.status, "completed");
    assert.equal(structured(result)?.eventsUri, undefined);
  } finally {
    await cold.dispose();
  }
});
