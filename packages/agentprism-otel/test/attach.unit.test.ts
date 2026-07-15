// Unit coverage for the pure WorkflowManager event bridge. These tests use a
// plain EventEmitter so the mapping is exercised without relying on engine internals.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  ATTR_AGENT_COUNT,
  ATTR_DANGLING,
  ATTR_DETACHED,
  ATTR_ERROR_CODE,
  ATTR_PAUSED,
  ATTR_PROMPT,
  ATTR_RESUMED,
  ATTR_RESULT,
  ATTR_RUN_ID,
  ATTR_STATUS,
  ATTR_STOPPED,
  ATTR_TOKEN_TYPE,
  ATTR_TOOL_INPUT,
  ATTR_TOOL_OUTPUT,
  ATTR_WORKTREE,
  EVENT_TOOL_STATUS,
  GEN_AI_AGENT_NAME,
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_NAME,
  METRIC_AGENT_DURATION,
  METRIC_AGENTS,
  METRIC_COST,
  METRIC_TOKENS,
  OPERATION_EXECUTE_TOOL,
  OPERATION_INVOKE_AGENT,
  VERSION,
} from "../src/constants.js";
import {
  attachOtel,
} from "../src/index.js";
import type { AgentPrismOtelOptions } from "../src/index.js";

function createHarness(options: AgentPrismOtelOptions = {}) {
  const manager = new EventEmitter();
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  const attachment = attachOtel(manager, {
    ...options,
    tracerProvider,
    meterProvider,
  });

  return {
    manager,
    spanExporter,
    metricExporter,
    tracerProvider,
    meterProvider,
    attachment,
    async flush() {
      await tracerProvider.forceFlush();
      await meterProvider.forceFlush();
    },
    async shutdown() {
      attachment.detach();
      await tracerProvider.shutdown().catch(() => {});
      await meterProvider.shutdown().catch(() => {});
    },
  };
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan {
  const span = spans.find((candidate) => candidate.name === name);
  assert.ok(span, `missing span ${name}`);
  return span;
}

function metricData(exporter: InMemoryMetricExporter, name: string): MetricData[] {
  return exporter
    .getMetrics()
    .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
    .flatMap((scopeMetrics) => scopeMetrics.metrics)
    .filter((metric) => metric.descriptor.name === name);
}

function sumMetricValue(exporter: InMemoryMetricExporter, name: string, attrs: Record<string, unknown> = {}): number {
  let total = 0;
  for (const metric of metricData(exporter, name)) {
    assert.equal(metric.dataPointType, DataPointType.SUM);
    for (const point of metric.dataPoints) {
      if (attributesMatch(point.attributes, attrs)) total += point.value;
    }
  }
  return total;
}

function histogramCount(exporter: InMemoryMetricExporter, name: string, attrs: Record<string, unknown>): number {
  let count = 0;
  for (const metric of metricData(exporter, name)) {
    assert.equal(metric.dataPointType, DataPointType.HISTOGRAM);
    for (const point of metric.dataPoints) {
      if (attributesMatch(point.attributes, attrs)) count += point.value.count;
    }
  }
  return count;
}

function attributesMatch(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

test("lazy root creation and complete mapping", async () => {
  const h = createHarness();
  try {
    h.manager.emit("complete", {
      runId: "run-complete",
      result: { meta: { name: "spec-demo" }, status: "completed", agentCount: 0 },
    });

    await h.flush();
    const root = findSpan(h.spanExporter.getFinishedSpans(), "workflow spec-demo");
    assert.equal(root.attributes[ATTR_RUN_ID], "run-complete");
    assert.equal(root.attributes[ATTR_STATUS], "completed");
    assert.equal(root.attributes[ATTR_AGENT_COUNT], 0);
    assert.equal(root.status.code, SpanStatusCode.OK);
  } finally {
    await h.shutdown();
  }
});

test("paused ends the run and resumed creates a new root trace", async () => {
  const h = createHarness();
  try {
    h.manager.emit("log", { runId: "run-resume", message: "before pause" });
    h.manager.emit("paused", { runId: "run-resume", reason: "usage_limit" });
    h.manager.emit("resumed", { runId: "run-resume" });
    h.manager.emit("complete", {
      runId: "run-resume",
      result: { meta: { name: "after-resume" }, status: "completed", agentCount: 0 },
    });

    await h.flush();
    const spans = h.spanExporter.getFinishedSpans();
    const pausedRoot = findSpan(spans, "workflow");
    const resumedRoot = findSpan(spans, "workflow after-resume");
    assert.equal(pausedRoot.attributes[ATTR_PAUSED], true);
    assert.equal(pausedRoot.status.code, SpanStatusCode.OK);
    assert.equal(resumedRoot.attributes[ATTR_RESUMED], true);
    assert.notEqual(pausedRoot.spanContext().traceId, resumedRoot.spanContext().traceId);
  } finally {
    await h.shutdown();
  }
});

test("error and stopped terminal events end root spans safely", async () => {
  const h = createHarness();
  try {
    h.manager.emit("error", { runId: "run-error", error: new Error("boom") });
    h.manager.emit("stopped", { runId: "run-stopped" });

    await h.flush();
    const spans = h.spanExporter.getFinishedSpans();
    const errorRoot = spans.find((span) => span.attributes[ATTR_RUN_ID] === "run-error");
    const stoppedRoot = spans.find((span) => span.attributes[ATTR_RUN_ID] === "run-stopped");
    assert.ok(errorRoot);
    assert.equal(errorRoot.status.code, SpanStatusCode.ERROR);
    assert.equal(errorRoot.status.message, "boom");
    assert.equal(errorRoot.events.some((event) => event.name === "exception"), true);
    assert.ok(stoppedRoot);
    assert.equal(stoppedRoot.attributes[ATTR_STOPPED], true);
    assert.equal(stoppedRoot.status.code, SpanStatusCode.UNSET);
  } finally {
    await h.shutdown();
  }
});

test("agent spans are parented to the workflow root and capture standard attributes", async () => {
  const h = createHarness({ captureContent: true });
  try {
    h.manager.emit("agentStart", {
      runId: "run-agent",
      label: "builder",
      phase: "Build",
      prompt: "make it",
      model: "provider/request",
    });
    h.manager.emit("agentEnd", {
      runId: "run-agent",
      label: "builder",
      result: { ok: true },
      tokens: 7,
      worktree: "/tmp/worktree",
      model: "provider/response",
    });
    h.manager.emit("complete", {
      runId: "run-agent",
      result: { meta: { name: "agent-parent" }, status: "completed", agentCount: 1 },
    });

    await h.flush();
    const spans = h.spanExporter.getFinishedSpans();
    const root = findSpan(spans, "workflow agent-parent");
    const agent = findSpan(spans, "invoke_agent builder");
    assert.equal(agent.spanContext().traceId, root.spanContext().traceId);
    assert.equal(agent.parentSpanContext?.spanId, root.spanContext().spanId);
    assert.equal(agent.attributes[GEN_AI_OPERATION_NAME], OPERATION_INVOKE_AGENT);
    assert.equal(agent.attributes[GEN_AI_AGENT_NAME], "builder");
    assert.equal(agent.attributes[GEN_AI_REQUEST_MODEL], "provider/request");
    assert.equal(agent.attributes[GEN_AI_RESPONSE_MODEL], "provider/response");
    assert.equal(agent.attributes[ATTR_WORKTREE], "/tmp/worktree");
    assert.equal(agent.attributes[ATTR_PROMPT], "make it");
    assert.equal(agent.attributes[ATTR_RESULT], '{"ok":true}');
  } finally {
    await h.shutdown();
  }
});

test("repeated labels are matched FIFO on agentEnd", async () => {
  const h = createHarness({ captureContent: true });
  try {
    h.manager.emit("agentStart", { runId: "run-fifo", label: "same", prompt: "first prompt" });
    h.manager.emit("agentStart", { runId: "run-fifo", label: "same", prompt: "second prompt" });
    h.manager.emit("agentEnd", { runId: "run-fifo", label: "same", result: "first result" });
    h.manager.emit("agentEnd", { runId: "run-fifo", label: "same", result: "second result" });
    h.manager.emit("complete", {
      runId: "run-fifo",
      result: { meta: { name: "fifo" }, status: "completed", agentCount: 2 },
    });

    await h.flush();
    const agents = h.spanExporter.getFinishedSpans().filter((span) => span.name === "invoke_agent same");
    assert.equal(agents.length, 2);
    assert.equal(agents[0]?.attributes[ATTR_PROMPT], "first prompt");
    assert.equal(agents[0]?.attributes[ATTR_RESULT], '"first result"');
    assert.equal(agents[1]?.attributes[ATTR_PROMPT], "second prompt");
    assert.equal(agents[1]?.attributes[ATTR_RESULT], '"second result"');
  } finally {
    await h.shutdown();
  }
});

test("scope and callIndex pair duplicate labels and parent tool spans directly", async () => {
  const h = createHarness({ captureContent: true });
  try {
    h.manager.emit("agentStart", {
      runId: "run-correlated",
      scope: "run-correlated-nested1",
      callIndex: 0,
      label: "same",
      prompt: "first prompt",
    });
    h.manager.emit("agentStart", {
      runId: "run-correlated",
      scope: "run-correlated-nested2",
      callIndex: 0,
      label: "same",
      prompt: "second prompt",
    });
    h.manager.emit("agentEvent", {
      name: "tool_call",
      runId: "run-correlated",
      scope: "run-correlated-nested1",
      callIndex: 0,
      label: "same",
      sessionId: "session-direct",
      backendId: "fake",
      event: { toolCallId: "tool-direct", title: "Direct tool" },
    });
    h.manager.emit("agentEvent", {
      name: "tool_call_update",
      runId: "run-correlated",
      scope: "run-correlated-nested1",
      callIndex: 0,
      sessionId: "session-direct",
      backendId: "fake",
      event: { toolCallId: "tool-direct", status: "completed" },
    });
    h.manager.emit("agentEnd", {
      runId: "run-correlated",
      scope: "run-correlated-nested2",
      callIndex: 0,
      label: "same",
      result: "second result",
    });
    h.manager.emit("agentEnd", {
      runId: "run-correlated",
      scope: "run-correlated-nested1",
      callIndex: 0,
      label: "same",
      result: "first result",
    });
    h.manager.emit("complete", {
      runId: "run-correlated",
      result: { meta: { name: "correlated" }, status: "completed", agentCount: 2 },
    });

    await h.flush();
    const spans = h.spanExporter.getFinishedSpans();
    const first = spans.find((span) => span.attributes[ATTR_PROMPT] === "first prompt");
    const second = spans.find((span) => span.attributes[ATTR_PROMPT] === "second prompt");
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.attributes[ATTR_RESULT], '"first result"');
    assert.equal(second.attributes[ATTR_RESULT], '"second result"');
    assert.equal(findSpan(spans, "execute_tool Direct tool").parentSpanContext?.spanId, first.spanContext().spanId);
  } finally {
    await h.shutdown();
  }
});

test("agentEnd error attributes are recorded and unmatched endings only count metrics", async () => {
  const h = createHarness();
  try {
    h.manager.emit("agentEnd", { runId: "run-unmatched", label: "missing", result: "ignored" });
    h.manager.emit("agentStart", { runId: "run-unmatched", label: "bad", prompt: "fail" });
    h.manager.emit("agentEnd", {
      runId: "run-unmatched",
      label: "bad",
      result: null,
      error: "agent failed",
      errorCode: "AGENT_EXECUTION_ERROR",
      recoverable: true,
    });
    h.manager.emit("complete", {
      runId: "run-unmatched",
      result: { meta: { name: "unmatched" }, status: "completed", agentCount: 1 },
    });

    await h.flush();
    const bad = findSpan(h.spanExporter.getFinishedSpans(), "invoke_agent bad");
    assert.equal(bad.status.code, SpanStatusCode.ERROR);
    assert.equal(bad.status.message, "agent failed");
    assert.equal(bad.attributes[ATTR_ERROR_CODE], "AGENT_EXECUTION_ERROR");
    assert.equal(bad.events.some((event) => event.name === "exception"), true);
    assert.equal(sumMetricValue(h.metricExporter, METRIC_AGENTS, { [ATTR_STATUS]: "ok" }), 1);
    assert.equal(sumMetricValue(h.metricExporter, METRIC_AGENTS, { [ATTR_STATUS]: "error" }), 1);
  } finally {
    await h.shutdown();
  }
});

test("tool calls parent under the newest matching agent and handle terminal, status, and dangling states", async () => {
  const h = createHarness({ captureContent: true });
  try {
    h.manager.emit("agentStart", { runId: "run-tools", label: "same", prompt: "first" });
    h.manager.emit("agentStart", { runId: "run-tools", label: "same", prompt: "second" });
    h.manager.emit("agentEvent", {
      name: "tool_call",
      runId: "run-tools",
      label: "same",
      sessionId: "session-1",
      backendId: "fake",
      event: { toolCallId: "tool-1", title: "Read file", kind: "read", rawInput: { path: "a.txt" } },
    });
    h.manager.emit("agentEvent", {
      name: "tool_call_update",
      runId: "run-tools",
      sessionId: "session-1",
      event: { toolCallId: "tool-1", status: "running" },
    });
    h.manager.emit("agentEvent", {
      name: "tool_call_update",
      runId: "run-tools",
      sessionId: "session-1",
      event: { toolCallId: "tool-1", status: "completed", title: "Read file", content: "done" },
    });
    h.manager.emit("agentEvent", {
      name: "tool_call",
      runId: "run-tools",
      label: "same",
      sessionId: "session-1",
      backendId: "fake",
      event: { toolCallId: "tool-2", kind: "write" },
    });
    h.manager.emit("agentEvent", {
      name: "tool_call_update",
      runId: "run-tools",
      sessionId: "session-1",
      event: { toolCallId: "tool-2", status: "failed" },
    });
    h.manager.emit("agentStart", { runId: "run-tools", label: "dangling", prompt: "open tool" });
    h.manager.emit("agentEvent", {
      name: "tool_call",
      runId: "run-tools",
      label: "dangling",
      sessionId: "session-2",
      backendId: "fake",
      event: { toolCallId: "tool-3", title: "Long tool" },
    });
    h.manager.emit("agentEnd", { runId: "run-tools", label: "dangling", result: "done" });
    h.manager.emit("agentEnd", { runId: "run-tools", label: "same", result: "first done" });
    h.manager.emit("agentEnd", { runId: "run-tools", label: "same", result: "second done" });
    h.manager.emit("complete", {
      runId: "run-tools",
      result: { meta: { name: "tools" }, status: "completed", agentCount: 3 },
    });

    await h.flush();
    const spans = h.spanExporter.getFinishedSpans();
    const sameAgents = spans.filter((span) => span.name === "invoke_agent same");
    const newestSameAgent = sameAgents.find((span) => span.attributes[ATTR_PROMPT] === "second");
    assert.ok(newestSameAgent);

    const completedTool = findSpan(spans, "execute_tool Read file");
    assert.equal(completedTool.parentSpanContext?.spanId, newestSameAgent.spanContext().spanId);
    assert.equal(completedTool.status.code, SpanStatusCode.OK);
    assert.equal(completedTool.attributes[GEN_AI_OPERATION_NAME], OPERATION_EXECUTE_TOOL);
    assert.equal(completedTool.attributes[GEN_AI_TOOL_NAME], "Read file");
    assert.equal(completedTool.attributes[GEN_AI_TOOL_CALL_ID], "tool-1");
    assert.equal(completedTool.attributes[ATTR_TOOL_INPUT], '{"path":"a.txt"}');
    assert.equal(completedTool.attributes[ATTR_TOOL_OUTPUT], '"done"');
    assert.equal(completedTool.events.some((event) => event.name === EVENT_TOOL_STATUS), true);

    const failedTool = findSpan(spans, "execute_tool write");
    assert.equal(failedTool.status.code, SpanStatusCode.ERROR);
    const danglingTool = findSpan(spans, "execute_tool Long tool");
    assert.equal(danglingTool.attributes[ATTR_DANGLING], true);
    assert.equal(danglingTool.status.code, SpanStatusCode.UNSET);
  } finally {
    await h.shutdown();
  }
});

test("tool events for unknown runs are ignored", async () => {
  const h = createHarness();
  try {
    h.manager.emit("agentEvent", {
      name: "tool_call",
      runId: "missing-run",
      label: "agent",
      sessionId: "session",
      backendId: "fake",
      event: { toolCallId: "tool", title: "Ignored" },
    });

    await h.flush();
    assert.equal(h.spanExporter.getFinishedSpans().length, 0);
  } finally {
    await h.shutdown();
  }
});

test("captureContent controls prompt, result, tool input, and terminal tool output attributes", async () => {
  const h1 = createHarness({ captureContent: false });
  try {
    h1.manager.emit("agentStart", { runId: "run-private", label: "agent", prompt: "secret prompt" });
    h1.manager.emit("agentEvent", {
      name: "tool_call",
      runId: "run-private",
      label: "agent",
      sessionId: "session",
      backendId: "fake",
      event: { toolCallId: "tool", title: "Tool", rawInput: { secret: true } },
    });
    h1.manager.emit("agentEvent", {
      name: "tool_call_update",
      runId: "run-private",
      sessionId: "session",
      event: { toolCallId: "tool", status: "completed", content: { secret: "output" } },
    });
    h1.manager.emit("agentEnd", { runId: "run-private", label: "agent", result: { secret: "result" } });
    h1.manager.emit("complete", {
      runId: "run-private",
      result: { meta: { name: "private" }, status: "completed", agentCount: 1 },
    });

    await h1.flush();
    const privateAgent = findSpan(h1.spanExporter.getFinishedSpans(), "invoke_agent agent");
    const privateTool = findSpan(h1.spanExporter.getFinishedSpans(), "execute_tool Tool");
    assert.equal(privateAgent.attributes[ATTR_PROMPT], undefined);
    assert.equal(privateAgent.attributes[ATTR_RESULT], undefined);
    assert.equal(privateTool.attributes[ATTR_TOOL_INPUT], undefined);
    assert.equal(privateTool.attributes[ATTR_TOOL_OUTPUT], undefined);
  } finally {
    await h1.shutdown();
  }

  const h2 = createHarness({ captureContent: true, contentLimit: 3 });
  try {
    h2.manager.emit("agentStart", { runId: "run-capture", label: "agent", prompt: "abcdef" });
    h2.manager.emit("agentEvent", {
      name: "tool_call",
      runId: "run-capture",
      label: "agent",
      sessionId: "session",
      backendId: "fake",
      event: { toolCallId: "tool", title: "Tool", rawInput: { long: "input" } },
    });
    h2.manager.emit("agentEvent", {
      name: "tool_call_update",
      runId: "run-capture",
      sessionId: "session",
      event: { toolCallId: "tool", status: "completed", content: { long: "output" } },
    });
    h2.manager.emit("agentEnd", { runId: "run-capture", label: "agent", result: { long: "result" } });
    h2.manager.emit("complete", {
      runId: "run-capture",
      result: { meta: { name: "capture" }, status: "completed", agentCount: 1 },
    });

    await h2.flush();
    const capturedAgent = findSpan(h2.spanExporter.getFinishedSpans(), "invoke_agent agent");
    const capturedTool = findSpan(h2.spanExporter.getFinishedSpans(), "execute_tool Tool");
    assert.equal(capturedAgent.attributes[ATTR_PROMPT], "abc…[truncated]");
    assert.match(String(capturedAgent.attributes[ATTR_RESULT]), /…\[truncated]$/);
    assert.match(String(capturedTool.attributes[ATTR_TOOL_INPUT]), /…\[truncated]$/);
    assert.match(String(capturedTool.attributes[ATTR_TOOL_OUTPUT]), /…\[truncated]$/);
  } finally {
    await h2.shutdown();
  }
});

test("token deltas, agent counters, and duration histograms are recorded with bounded cardinality", async () => {
  const h = createHarness();
  try {
    h.manager.emit("tokenUsage", {
      runId: "run-metrics",
      usage: { input: 10, output: 5, total: 15, cost: 0.03, cacheRead: 2, cacheWrite: 1 },
    });
    h.manager.emit("tokenUsage", {
      runId: "run-metrics",
      usage: { input: 13, output: 7, total: 20, cost: 0.04, cacheRead: 2, cacheWrite: 3 },
    });
    h.manager.emit("tokenUsage", {
      runId: "run-metrics",
      usage: { input: 1, output: 1, total: 1, cost: 0, cacheRead: 0, cacheWrite: 0 },
    });
    h.manager.emit("agentStart", { runId: "run-metrics", label: "ok", prompt: "ok" });
    h.manager.emit("agentEnd", { runId: "run-metrics", label: "ok", result: "ok" });
    h.manager.emit("agentStart", { runId: "run-metrics", label: "err", prompt: "err" });
    h.manager.emit("agentEnd", { runId: "run-metrics", label: "err", result: null, error: "bad" });
    h.manager.emit("agentEnd", { runId: "run-metrics", label: "missing", result: "still counted" });
    h.manager.emit("complete", {
      runId: "run-metrics",
      result: { meta: { name: "metrics" }, status: "completed", agentCount: 2 },
    });

    await h.flush();
    assert.equal(sumMetricValue(h.metricExporter, METRIC_TOKENS, { [ATTR_TOKEN_TYPE]: "input" }), 13);
    assert.equal(sumMetricValue(h.metricExporter, METRIC_TOKENS, { [ATTR_TOKEN_TYPE]: "output" }), 7);
    assert.equal(sumMetricValue(h.metricExporter, METRIC_TOKENS, { [ATTR_TOKEN_TYPE]: "total" }), 20);
    assert.equal(sumMetricValue(h.metricExporter, METRIC_TOKENS, { [ATTR_TOKEN_TYPE]: "cache_read" }), 2);
    assert.equal(sumMetricValue(h.metricExporter, METRIC_TOKENS, { [ATTR_TOKEN_TYPE]: "cache_write" }), 3);
    assert.equal(sumMetricValue(h.metricExporter, METRIC_COST), 0.04);
    assert.equal(sumMetricValue(h.metricExporter, METRIC_AGENTS, { [ATTR_STATUS]: "ok" }), 2);
    assert.equal(sumMetricValue(h.metricExporter, METRIC_AGENTS, { [ATTR_STATUS]: "error" }), 1);
    assert.equal(histogramCount(h.metricExporter, METRIC_AGENT_DURATION, { [ATTR_STATUS]: "ok" }), 1);
    assert.equal(histogramCount(h.metricExporter, METRIC_AGENT_DURATION, { [ATTR_STATUS]: "error" }), 1);
    for (const metric of metricData(h.metricExporter, METRIC_AGENTS)) {
      for (const point of metric.dataPoints) assert.equal(point.attributes[ATTR_RUN_ID], undefined);
    }
  } finally {
    await h.shutdown();
  }
});

test("malformed payloads never throw into the manager", async () => {
  const h = createHarness();
  try {
    assert.doesNotThrow(() => {
      h.manager.emit("log", undefined);
      h.manager.emit("phase", { title: "missing run" });
      h.manager.emit("agentStart", { runId: "bad" });
      h.manager.emit("agentEnd", { label: "missing run" });
      h.manager.emit("tokenUsage", { runId: "bad", usage: undefined });
      h.manager.emit("complete", undefined);
      h.manager.emit("paused", { reason: "missing run" });
      h.manager.emit("error", undefined);
      h.manager.emit("stopped", undefined);
      h.manager.emit("resumed", undefined);
      h.manager.emit("agentEvent", undefined);
      h.manager.emit("agentEvent", { name: "tool_call", event: undefined });
      h.manager.emit("agentEvent", { name: "tool_call_update", event: undefined });
    });
    await h.flush();
  } finally {
    await h.shutdown();
  }
});

test("detach removes subscriptions and force-ends open spans with detached=true", async () => {
  const h = createHarness();
  try {
    h.manager.emit("agentStart", { runId: "run-detach", label: "agent", prompt: "open" });
    h.manager.emit("agentEvent", {
      name: "tool_call",
      runId: "run-detach",
      label: "agent",
      sessionId: "session",
      backendId: "fake",
      event: { toolCallId: "tool", title: "Open tool" },
    });
    assert.ok(h.manager.listenerCount("agentStart") > 0);

    h.attachment.detach();
    await h.flush();
    const spans = h.spanExporter.getFinishedSpans();
    assert.equal(h.manager.listenerCount("agentStart"), 0);
    assert.equal(findSpan(spans, "workflow").attributes[ATTR_DETACHED], true);
    assert.equal(findSpan(spans, "invoke_agent agent").attributes[ATTR_DETACHED], true);
    assert.equal(findSpan(spans, "execute_tool Open tool").attributes[ATTR_DETACHED], true);

    const countAfterDetach = spans.length;
    h.manager.emit("complete", {
      runId: "run-detach",
      result: { meta: { name: "after-detach" }, status: "completed", agentCount: 1 },
    });
    await h.flush();
    assert.equal(h.spanExporter.getFinishedSpans().length, countAfterDetach);
  } finally {
    await h.shutdown();
  }
});

test("VERSION stays in sync with package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});
