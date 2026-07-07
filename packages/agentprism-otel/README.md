# @automatalabs/agentprism-otel

OpenTelemetry tracing and metrics for AgentPrism workflow runs. The package attaches to any `WorkflowManager`-compatible event emitter and maps workflow events to spans and counters using `@opentelemetry/api` only.

With no OpenTelemetry SDK registered by the host, calls are no-ops by design. Attaching is safe in libraries and CLIs that do not own telemetry setup.

## Quickstart

Configure your SDK in the host process, then attach the bridge to the manager:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { WorkflowManager, createAcpRunner } from "@automatalabs/workflows";
import { attachOtel } from "@automatalabs/agentprism-otel";

const sdk = new NodeSDK({
  // traceExporter, metricReader, resource, etc.
});
await sdk.start();

const manager = new WorkflowManager({ agent: createAcpRunner() });
const telemetry = attachOtel(manager, {
  captureContent: false,
});

const result = await manager.runSync(script);
telemetry.detach();
```

Calling `attachOtel()` twice on the same manager creates two independent attachments and two independent sets of subscriptions. Call each returned `detach()` when that observer is no longer needed.

## API

```ts
export interface AgentPrismOtelOptions {
  tracerProvider?: TracerProvider;
  meterProvider?: MeterProvider;
  captureContent?: boolean;
  contentLimit?: number;
}

export interface OtelAttachment {
  detach(): void;
}

export function attachOtel(manager: WorkflowManagerLike, options?: AgentPrismOtelOptions): OtelAttachment;
```

| Option | Default | Effect |
|---|---:|---|
| `tracerProvider` | `trace.getTracerProvider()` | Provider used to create the `@automatalabs/agentprism-otel` tracer. |
| `meterProvider` | `metrics.getMeterProvider()` | Provider used to create the `@automatalabs/agentprism-otel` meter. |
| `captureContent` | `false` | When true, captures prompts, results, tool input, and terminal tool output as span attributes. |
| `contentLimit` | `8192` | Maximum characters kept per captured content attribute before `…[truncated]` is appended. |

`detach()` removes all subscriptions created by that attachment, then force-ends any still-open tool, agent, and workflow spans with `agentprism.detached = true`.

## Span Model

| Span | Created from | Parent | Ended by |
|---|---|---|---|
| `workflow` | First handled event with a new `runId` | Current context | `complete`, `paused`, `error`, `stopped`, or `detach()` |
| `workflow <name>` | `complete` with `result.meta.name` | Current context | Same root span, renamed before end |
| `invoke_agent <label>` | `agentStart` | Workflow root | Matching FIFO `agentEnd`, terminal run cleanup, or `detach()` |
| `execute_tool <title\|kind\|tool>` | `agentEvent` `tool_call` | Most recent open agent for `label`, else workflow root | Terminal `tool_call_update`, agent cleanup, terminal run cleanup, or `detach()` |

Repeated agent labels are matched FIFO on `agentEnd`. Tool calls parent to the most recent still-open agent with that label.

## Attribute Reference

| Attribute | Spans | Notes |
|---|---|---|
| `agentprism.run_id` | workflow, agent, tool | Per-run trace attribution. |
| `agentprism.resumed` | workflow | Set on roots created by `resumed`. |
| `agentprism.status` | workflow | Terminal `WorkflowRunResult.status`, when present. |
| `agentprism.agent_count` | workflow | Terminal agent count, when present. |
| `agentprism.paused`, `agentprism.pause_reason` | workflow | Set on paused runs. |
| `agentprism.stopped` | workflow | Set on stopped runs. |
| `agentprism.detached` | workflow, agent, tool | Set when `detach()` force-ends open spans. |
| `agentprism.dangling` | agent, tool | Set when a terminal run or agent end force-closes children. |
| `agentprism.phase`, `agentprism.last_phase` | workflow, agent | Phase events and agent phase attribution. |
| `agentprism.prompt`, `agentprism.result` | agent | Only when `captureContent` is true. |
| `agentprism.tokens`, `agentprism.worktree` | agent | From `agentEnd`. |
| `agentprism.error_code`, `agentprism.recoverable` | agent | From failed `agentEnd`. |
| `agentprism.backend_id`, `agentprism.session_id`, `agentprism.label` | tool | ACP context repeated on tool spans. |
| `agentprism.tool_kind`, `agentprism.tool_status` | tool | Tool kind and non-terminal status updates. |
| `agentprism.tool_input`, `agentprism.tool_output` | tool | Only when `captureContent` is true; output is terminal updates only. |
| `log.message` | workflow log events | Workflow `log()` narration is always added as a span event. |
| `gen_ai.operation.name` | agent, tool | `invoke_agent` or `execute_tool`. |
| `gen_ai.agent.name` | agent | Agent label. |
| `gen_ai.request.model`, `gen_ai.response.model` | agent | Requested/resolved model when available. |
| `gen_ai.tool.name`, `gen_ai.tool.call.id` | tool | Tool title and call id. |

Workflow `log` events are always attached to the root span, even when `captureContent` is false. `log()` is author-intended narration; prompts, results, and tool payloads remain gated by `captureContent`.

## Metric Reference

| Metric | Instrument | Unit | Attributes | Notes |
|---|---|---|---|---|
| `agentprism.tokens` | Counter | `{token}` | `agentprism.token_type` = `input`, `output`, `total`, `cache_read`, `cache_write` | Records positive deltas from cumulative `tokenUsage` snapshots. |
| `agentprism.cost` | Counter | `usd` | none | Records positive cost deltas from cumulative snapshots. |
| `agentprism.agents` | Counter | `{agent}` | `agentprism.status` = `ok` or `error` | Increments on every `agentEnd`, including unmatched endings. |
| `agentprism.agent.duration` | Histogram | `s` | `agentprism.status` = `ok` or `error` | Recorded only when `agentEnd` matches an open `agentStart`. |

Metrics intentionally do not carry `runId` to avoid high-cardinality time series. Use trace attributes for per-run attribution.

## Privacy

`captureContent` defaults to false. When enabled, prompts, results, tool inputs, and terminal tool outputs are serialized into span attributes and truncated to `contentLimit`. Keep it disabled for production telemetry unless your exporter and backend are approved for that data.

## Event Surface

The bridge subscribes to `log`, `phase`, `agentStart`, `agentEnd`, `tokenUsage`, `complete`, `paused`, `error`, `stopped`, `resumed`, and facade `agentEvent` tool-call updates. It does not subscribe to `journal` or `agentHistory`.

Every handler is wrapped and reports failures through OpenTelemetry diagnostics, so malformed payloads or exporter behavior cannot throw into the manager.
