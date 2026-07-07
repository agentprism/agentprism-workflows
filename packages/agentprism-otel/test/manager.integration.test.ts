// Integration coverage through the public @automatalabs/workflows facade. The
// fake runner exposes the ACP-style event bus so WorkflowManager re-emits live
// tool updates as manager agentEvent payloads.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  TypedEventEmitter,
  WorkflowManager,
  type AcpEventListener,
  type AcpEventName,
  type AcpRunnerEventMap,
  type AgentRunner,
  type RunOptions,
} from "@automatalabs/workflows";
import {
  ATTR_RUN_ID,
  ATTR_STATUS,
  GEN_AI_TOOL_CALL_ID,
  METRIC_AGENTS,
  METRIC_TOKENS,
} from "../src/constants.js";
import { attachOtel } from "../src/index.js";

const SCRIPT = [
  'export const meta = { name: "otel_integration", description: "otel integration", phases: [{ title: "Build" }] };',
  'phase("Build");',
  'log("integration log");',
  'const first = await agent("first prompt", { label: "tool-agent" });',
  'const second = await agent("second prompt", { label: "plain-agent" });',
  "return { first, second };",
].join("\n");

class FakeAcpRunner {
  private readonly events = new TypedEventEmitter<AcpRunnerEventMap>();
  private seq = 0;
  readonly backendId = "fake-backend";

  on<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void {
    return this.events.on(name, listener);
  }

  async run(prompt: string, options?: RunOptions): Promise<unknown> {
    const ctx = {
      sessionId: `session-${++this.seq}`,
      backendId: this.backendId,
      label: options?.label,
      runId: options?.runId,
    };

    if (options?.label === "tool-agent") {
      const call = {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "List files",
        kind: "read",
        status: "pending",
        rawInput: { command: "ls" },
      } as AcpRunnerEventMap["session_update"]["update"];
      this.events.emit("session_update", { ...ctx, update: call });
      await Promise.resolve();
      const update = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "List files",
        status: "completed",
        content: "listed",
      } as AcpRunnerEventMap["session_update"]["update"];
      this.events.emit("session_update", { ...ctx, update });
    }

    options?.onUsage?.({
      input: prompt.length,
      output: 3,
      total: prompt.length + 3,
      cost: 0.01,
      cacheRead: 0,
      cacheWrite: 0,
    });
    await Promise.resolve();
    return `fake:${prompt}`;
  }
}

function createTelemetry() {
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
  return {
    spanExporter,
    metricExporter,
    tracerProvider,
    meterProvider,
    async flush() {
      await tracerProvider.forceFlush();
      await meterProvider.forceFlush();
    },
    async shutdown() {
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

function metricTotal(exporter: InMemoryMetricExporter, name: string): number {
  let total = 0;
  for (const metric of metricData(exporter, name)) {
    assert.equal(metric.dataPointType, DataPointType.SUM);
    for (const point of metric.dataPoints) total += point.value;
  }
  return total;
}

test("WorkflowManager facade events map to root, agent, tool spans and metrics", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ap-otel-cwd-"));
  const persistenceRoot = mkdtempSync(join(tmpdir(), "ap-otel-root-"));
  const telemetry = createTelemetry();
  const runner = new FakeAcpRunner();
  const manager = new WorkflowManager({
    cwd,
    persistenceRoot,
    agent: runner as unknown as AgentRunner,
  });
  const attachment = attachOtel(manager, {
    tracerProvider: telemetry.tracerProvider,
    meterProvider: telemetry.meterProvider,
    captureContent: true,
  });

  try {
    const result = await manager.runSync(SCRIPT);
    assert.equal(result.status, "completed");
    assert.equal(result.meta.name, "otel_integration");

    await telemetry.flush();
    const spans = telemetry.spanExporter.getFinishedSpans();
    const root = findSpan(spans, "workflow otel_integration");
    assert.equal(root.attributes[ATTR_RUN_ID], result.runId);
    assert.equal(root.attributes[ATTR_STATUS], "completed");
    assert.equal(root.status.code, SpanStatusCode.OK);

    const agents = spans.filter((span) => span.name.startsWith("invoke_agent "));
    assert.equal(agents.length, 2);
    const toolAgent = findSpan(spans, "invoke_agent tool-agent");
    const plainAgent = findSpan(spans, "invoke_agent plain-agent");
    assert.equal(toolAgent.parentSpanContext?.spanId, root.spanContext().spanId);
    assert.equal(plainAgent.parentSpanContext?.spanId, root.spanContext().spanId);

    const tool = findSpan(spans, "execute_tool List files");
    assert.equal(tool.parentSpanContext?.spanId, toolAgent.spanContext().spanId);
    assert.equal(tool.attributes[GEN_AI_TOOL_CALL_ID], "tool-1");
    assert.equal(tool.status.code, SpanStatusCode.OK);

    assert.ok(metricTotal(telemetry.metricExporter, METRIC_TOKENS) > 0);
    assert.equal(metricTotal(telemetry.metricExporter, METRIC_AGENTS), 2);

    const countBeforeDetach = spans.length;
    attachment.detach();
    await telemetry.flush();
    assert.equal(telemetry.spanExporter.getFinishedSpans().length, countBeforeDetach, "complete leaves no open spans");
  } finally {
    attachment.detach();
    manager.dispose();
    await telemetry.shutdown();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});
