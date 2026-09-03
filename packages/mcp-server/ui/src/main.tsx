// Run-monitor panel entrypoint (React, @modelcontextprotocol/ext-apps/react).
//
import type { CallToolResult } from "@modelcontextprotocol/client";

// Rendered by MCP Apps hosts for `workflow` tool calls (the tool carries
// _meta.ui.resourceUri). The panel derives the runId from whichever arrives first:
//   - tool ARGUMENTS for resume/status/result/permissions-response/stop, or
//   - the tool RESULT's structuredContent.runId for fresh run calls.
// Before a new runId is known, inline run input (or a resume source resource) supplies the static
// plan. Once known, the panel keeps itself live with the MCP Apps Interactive Updates pattern: it
// polls the app-only `workflow-events` tool (~2s while live, adaptive backoff when idle or faulted)
// and folds structured event pages into the render model. A second app-only bounded query
// supplies active/recent project runs so a surviving host panel remains navigable. Server-side capability
// negotiation gates access to that tool and this panel. Polling itself carries no model-notification
// machinery; selected folded events use ui/message. Hosts that narrate app-originated tool calls
// diverge from the official design; that compatibility issue is tracked at
// nicobailon/pi-mcp-adapter#314. Stop issues `workflow` action:"stop" through the host bridge.
import type { App } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostFonts, useHostStyleVariables } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { DetailView } from "./DetailView.js";
import { fmtCost, fmtDuration, fmtTokens, shortRunId } from "./format.js";
import { GraphView } from "./GraphView.js";
import type { NodeSelection } from "./GraphView.js";
import { createModelMessageState, sendModelMessagesForFold } from "./model-messages.js";
import {
  classifyPollFailure,
  nextErrorBackoffMs,
  nextIdleDelayMs,
  POLL_MS,
  shouldGiveUp,
} from "./poll-backoff.js";
import { extractSkeleton } from "./skeleton.js";
import type { Skeleton } from "./skeleton.js";
import { agentCount, createRunModel, foldRecord } from "./state.js";
import {
  inlineSkeletonFromArgs,
  observedRunIdFromArgs,
  skeletonSourceRunIdFromArgs,
} from "./tool-input.js";
import type { RunModel, RunStatus } from "./state.js";
import { readWorkflowEventsPage } from "./workflow-events-poll.js";
import type { EventsDoc } from "./workflow-events-poll.js";
import { readRecentRuns, type RunListItem } from "./workflow-runs.js";
import "./style.css";

function runIdFromResult(result: CallToolResult | null): string | undefined {
  const structured = result?.structuredContent as { runId?: unknown } | undefined;
  return typeof structured?.runId === "string" && structured.runId.length > 0
    ? structured.runId
    : undefined;
}

interface MonitorState {
  model: RunModel | null;
  connectionLost: boolean;
  /** Latched once the poll loop gives up for good (bounded consecutive faults); render is stale. */
  disconnected: boolean;
  fatal: string | undefined;
}

/**
 * Poll the app-only events tool into a fold-model; re-renders by bumping a version counter.
 * `tornDown` stops the loop for good once the host tears the panel down, so a replaced or
 * dismissed panel cannot keep calling the server from a detached iframe.
 *
 * This is the MCP Apps Interactive Updates pattern, and access is gated by server-side extension
 * negotiation. Hosts that narrate app-originated calls diverge from the official design; tracked at
 * nicobailon/pi-mcp-adapter#314. The first call discovers the stream generation, then cursor pages
 * carry it explicitly. Idle polls back off (2s→4s→8s→cap) and reset on new events; a bounded run of
 * call faults gives up for good rather than retrying a dead run forever.
 */
function useRunModel(
  app: App | null,
  runId: string | undefined,
  tornDown: boolean,
  narrateToModel: boolean,
): MonitorState {
  const modelRef = useRef<RunModel | null>(null);
  const [, setVersion] = useState(0);
  const [connectionLost, setConnectionLost] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [fatal, setFatal] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!app || runId === undefined || tornDown) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let backoffMs = POLL_MS;
    let idleDelayMs = POLL_MS;
    let consecutiveFailures = 0;
    let finalConfirmDone = false;
    const modelMessages = createModelMessageState();
    modelRef.current = createRunModel(runId);
    setFatal(undefined);
    setConnectionLost(false);
    setDisconnected(false);
    setVersion((version) => version + 1);

    const bump = () => setVersion((version) => version + 1);
    const schedule = (delayMs: number) => {
      if (cancelled) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void poll(), delayMs);
    };
    const degrade = () => {
      consecutiveFailures += 1;
      if (shouldGiveUp(consecutiveFailures)) {
        // The run is unreachable (dead daemon, deleted store, host down). Stop for good and show a
        // disconnected panel rather than retrying a long-gone run forever at the backoff cap.
        setConnectionLost(false);
        setDisconnected(true);
        return;
      }
      setConnectionLost(true);
      backoffMs = nextErrorBackoffMs(backoffMs);
      schedule(backoffMs);
    };
    const onPollError = (error: unknown): void => {
      const failure = classifyPollFailure(error);
      if (failure === "rebuild") {
        // Stream generation changed (run deleted/recreated): rebuild and re-bootstrap the stream.
        modelRef.current = createRunModel(runId);
        consecutiveFailures = 0;
        idleDelayMs = POLL_MS;
        bump();
        schedule(POLL_MS);
      } else if (failure === "run-not-found") {
        setFatal("This run is no longer present in the run store.");
      } else {
        degrade();
      }
    };

    const poll = async (): Promise<void> => {
      const model = modelRef.current;
      if (cancelled || !model) return;
      let doc: EventsDoc | undefined;
      try {
        doc = await readWorkflowEventsPage(app, {
          runId,
          after: model.cursor,
          streamId: model.streamId,
        });
        if (cancelled) return;
      } catch (error) {
        if (cancelled) return;
        onPollError(error);
        return;
      }
      if (doc === undefined) {
        degrade();
        return;
      }

      // A read succeeded: clear fault state and the error backoff.
      consecutiveFailures = 0;
      backoffMs = POLL_MS;
      setConnectionLost(false);
      setDisconnected(false);

      if (model.streamId === undefined) {
        // Bootstrap read: adopt the stream generation and workflow name.
        model.streamId = doc.streamId;
        if (model.name === undefined && doc.workflowName) model.name = doc.workflowName;
        if (doc.after !== 0) {
          // The canonical read returned a tail window (the run already had more than a page of
          // events when the panel opened). Keep the cursor at 0 and immediately re-read from the
          // start with the now-known streamId so the fold model is complete, not just the tail.
          bump();
          idleDelayMs = POLL_MS;
          schedule(0);
          return;
        }
        // doc.after === 0: the canonical read covered the whole log; fold it and page by cursor.
      }

      for (const record of doc.events) foldRecord(model, record);
      model.cursor = doc.cursor;
      model.status = doc.status;
      model.finalized = doc.finalized;
      if (model.name === undefined && doc.workflowName) model.name = doc.workflowName;
      // Only the run this tool call belongs to narrates to the model; runs the user browses
      // through the navigator are app-local observation and must stay silent.
      if (narrateToModel) sendModelMessagesForFold(app, runId, doc.after, doc.events, modelMessages);
      bump();

      if (doc.hasMore) {
        idleDelayMs = POLL_MS;
        schedule(0);
      } else if (!model.finalized) {
        // Adaptive idle backoff: reset to the base cadence when a poll brought new events, else
        // double the next delay toward the cap so an idle/paused run is not polled every 2s.
        idleDelayMs = nextIdleDelayMs(idleDelayMs, doc.events.length > 0);
        schedule(idleDelayMs);
      } else if (!finalConfirmDone) {
        // One trailing read after the terminal status, in case late records land.
        finalConfirmDone = true;
        schedule(1500);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [app, runId, tornDown, narrateToModel]);

  return {
    model: runId === undefined || modelRef.current?.runId !== runId ? null : modelRef.current,
    connectionLost,
    disconnected,
    fatal,
  };
}

function useRecentRuns(app: App | null, anchorRunId: string | undefined, tornDown: boolean): RunListItem[] {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  useEffect(() => {
    if (!app || !anchorRunId || tornDown) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const next = await readRecentRuns(app, anchorRunId);
        if (!cancelled) setRuns(next);
      } catch {
        // Run event polling remains authoritative for the selected run; stale navigation is safe.
      }
      if (!cancelled) timer = setTimeout(() => void refresh(), 5_000);
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [app, anchorRunId, tornDown]);
  return runs;
}

/**
 * Prefer an admitted script resource once its run id is available, with the inline run-input plan
 * as an immediate fallback. Any resource or parse failure yields the fallback skeleton (or the
 * timing-based wave view when no static source exists).
 */
function useSkeleton(
  app: App | null,
  runId: string | undefined,
  inlineSkeleton: Skeleton | undefined,
): Skeleton | undefined {
  const [loaded, setLoaded] = useState<
    { runId: string; skeleton: Skeleton | undefined } | undefined
  >(undefined);
  useEffect(() => {
    if (!app || runId === undefined) return;
    let cancelled = false;
    setLoaded(undefined);
    void (async () => {
      let skeleton: Skeleton | undefined;
      try {
        const result = await app.readServerResource({ uri: `workflow://runs/${runId}/script` });
        if (cancelled) return;
        const text = (result.contents as Array<{ text?: unknown }>).find(
          (content) => typeof content.text === "string",
        )?.text as string | undefined;
        if (text !== undefined) skeleton = extractSkeleton(text);
      } catch {
        // Fall back silently; inline run input or the wave view needs no resource read.
      }
      if (!cancelled) setLoaded({ runId, skeleton });
    })();
    return () => {
      cancelled = true;
    };
  }, [app, runId]);
  if (runId === undefined || loaded?.runId !== runId) return inlineSkeleton;
  return loaded.skeleton ?? inlineSkeleton;
}

function ElapsedClock({ model }: { model: RunModel }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (model.finalized) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [model.finalized]);
  if (model.startTs === undefined) return <span className="elapsed" />;
  const end = model.finalized && model.endTs !== undefined ? model.endTs : Date.now();
  return <span className="elapsed">{fmtDuration(end - model.startTs)}</span>;
}

function RunStatusChip({ status }: { status: RunStatus }) {
  switch (status) {
    case "completed":
      return <span className="chip chip-ok">✓ Completed</span>;
    case "failed":
      return <span className="chip chip-err">✗ Failed</span>;
    case "aborted":
      return <span className="chip chip-err">■ Stopped</span>;
    case "paused":
      return <span className="chip chip-warn">⏸ Paused</span>;
    default:
      return (
        <span className="chip chip-live">
          <span className="pulse" />
          Running
        </span>
      );
  }
}

function StopButton({ app, runId }: { app: App; runId: string }) {
  const [state, setState] = useState<"idle" | "confirm" | "pending">("idle");

  useEffect(() => {
    if (state !== "confirm") return;
    const timer = setTimeout(() => {
      setState((current) => (current === "confirm" ? "idle" : current));
    }, 4000);
    return () => clearTimeout(timer);
  }, [state]);

  const onClick = async () => {
    if (state === "idle") {
      setState("confirm");
      return;
    }
    if (state !== "confirm") return;
    setState("pending");
    try {
      await app.callServerTool({ name: "workflow", arguments: { action: "stop", runId } });
    } catch {
      // The polling loop surfaces the run's actual fate; a failed stop just re-arms the button.
    } finally {
      setState("idle");
    }
  };

  return (
    <button
      className={`stop-btn${state === "confirm" ? " confirming" : ""}`}
      disabled={state === "pending"}
      onClick={() => void onClick()}
    >
      {state === "confirm" ? "Confirm stop?" : state === "pending" ? "Stopping…" : "Stop"}
    </button>
  );
}

function MonitorBody({
  app,
  model,
  skeleton,
  connectionLost,
  disconnected,
  fatal,
  runs,
  onSelectRun,
}: {
  app: App;
  model: RunModel;
  skeleton: Skeleton | undefined;
  connectionLost: boolean;
  disconnected: boolean;
  fatal: string | undefined;
  runs: RunListItem[];
  onSelectRun: (runId: string) => void;
}) {
  const [view, setView] = useState<{ kind: "graph" } | { kind: "detail"; target: NodeSelection }>({
    kind: "graph",
  });
  const [expandedWaves, setExpandedWaves] = useState<ReadonlySet<string>>(new Set());
  const [loopSelections, setLoopSelections] = useState<ReadonlyMap<string, number>>(new Map());

  // Once the poll loop has given up for good the panel can no longer act on the run: freeze the
  // live affordances (Stop) and show a stale marker instead of the transient "reconnecting…".
  const live = !model.finalized && model.status !== "completed" && !disconnected;
  const bannerMessage = fatal ?? model.banner;
  const bannerIsError =
    fatal !== undefined || model.status === "failed" || model.status === "aborted";
  const usage = model.usage;

  // The viewed run always stays selectable even when a bounded listing no longer includes it.
  const listedRuns: RunListItem[] = runs.some((run) => run.runId === model.runId)
    ? runs
    : [
        {
          runId: model.runId,
          workflowName: model.name ?? "workflow",
          status: model.status,
          startedAt: "",
          updatedAt: "",
        },
        ...runs,
      ];
  const activeRuns = listedRuns.filter((run) => run.status === "pending" || run.status === "running" || run.status === "paused");
  const recentRuns = listedRuns.filter((run) => run.status === "completed" || run.status === "failed" || run.status === "aborted");
  return (
    <>
      <header className="bar top">
        {listedRuns.length > 1 && (
          <select
            className="run-switch"
            value={model.runId}
            aria-label="Navigate active and recent workflow runs"
            onChange={(event) => onSelectRun(event.target.value)}
          >
            {activeRuns.length > 0 && (
              <optgroup label="Active">
                {activeRuns.map((run) => (
                  <option key={run.runId} value={run.runId}>{run.workflowName} · {run.status}</option>
                ))}
              </optgroup>
            )}
            {recentRuns.length > 0 && (
              <optgroup label="Recent">
                {recentRuns.map((run) => (
                  <option key={run.runId} value={run.runId}>{run.workflowName} · {run.status}</option>
                ))}
              </optgroup>
            )}
          </select>
        )}
        <span className="wf-name">{model.name ?? "workflow"}</span>
        <span className="run-id">run {shortRunId(model.runId)}</span>
        <span className="run-id">{agentCount(model)} agents</span>
        <RunStatusChip status={model.status} />
        <ElapsedClock model={model} />
        <span className="spacer" />
        {disconnected ? (
          <span className="conn-lost" title="The run monitor stopped receiving updates.">
            disconnected — updates stopped
          </span>
        ) : (
          connectionLost && <span className="conn-lost">reconnecting…</span>
        )}
        {live && <StopButton app={app} runId={model.runId} />}
      </header>
      {bannerMessage !== undefined && (
        <div className={`banner${bannerIsError ? " banner-error" : ""}`}>{bannerMessage}</div>
      )}
      {view.kind === "graph" ? (
        <GraphView
          model={model}
          skeleton={skeleton}
          expandedWaves={expandedWaves}
          onExpandWave={(waveKey) =>
            setExpandedWaves((current) => new Set([...current, waveKey]))
          }
          loopSelections={loopSelections}
          onSelectLoopIteration={(loopId, iteration) =>
            setLoopSelections((current) => new Map([...current, [loopId, iteration]]))
          }
          onSelect={(target) => setView({ kind: "detail", target })}
        />
      ) : (
        <DetailView model={model} target={view.target} onBack={() => setView({ kind: "graph" })} />
      )}
      <footer className="bar bottom">
        {view.kind === "graph" ? (
          <span className="hint">Select a node to inspect</span>
        ) : (
          <span className="hint" />
        )}
        <span className="spacer" />
        {usage !== undefined && (
          <span className="totals">
            <strong>{fmtTokens(usage.total)}</strong>
            {" tok"}
            {"  "}
            {fmtCost(usage.cost)}
          </span>
        )}
      </footer>
    </>
  );
}

function StartingSkeleton({
  skeleton,
  rejected,
}: {
  skeleton: Skeleton;
  rejected: boolean;
}) {
  const [expandedWaves, setExpandedWaves] = useState<ReadonlySet<string>>(new Set());
  const [loopSelections, setLoopSelections] = useState<ReadonlyMap<string, number>>(new Map());
  const model = createRunModel("pending-run");
  if (skeleton.name !== undefined) model.name = skeleton.name;

  return (
    <>
      <header className="bar top">
        <span className="wf-name">{skeleton.name ?? "workflow"}</span>
        <span className="run-id">planned structure</span>
        {rejected ? (
          <span className="chip chip-err">Not admitted</span>
        ) : (
          <span className="chip chip-live">
            <span className="pulse" />
            Starting
          </span>
        )}
      </header>
      <GraphView
        model={model}
        skeleton={skeleton}
        expandedWaves={expandedWaves}
        onExpandWave={(key) => setExpandedWaves((current) => new Set([...current, key]))}
        loopSelections={loopSelections}
        onSelectLoopIteration={(loopId, iteration) =>
          setLoopSelections((current) => new Map([...current, [loopId, iteration]]))
        }
        onSelect={() => undefined}
      />
      <footer className="bar bottom">
        <span className="hint">
          {rejected ? "The request failed before a run was created" : "Static workflow structure"}
        </span>
      </footer>
    </>
  );
}

function RunMonitor() {
  const [toolArgs, setToolArgs] = useState<Record<string, unknown> | null>(null);
  const [toolResult, setToolResult] = useState<CallToolResult | null>(null);
  // The host tears the panel down when its session completes or the user dismisses it. Latch
  // it so event polling (and therefore new model messages) stops permanently.
  const [tornDown, setTornDown] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);

  const { app, error } = useApp({
    appInfo: { name: "AgentPrism Run Monitor", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (created) => {
      created.ontoolinput = (input) => {
        setToolArgs((input.arguments as Record<string, unknown> | undefined) ?? {});
      };
      created.ontoolresult = (result) => setToolResult(result);
      created.onteardown = async () => {
        setTornDown(true);
        return {};
      };
      created.onerror = console.error;
    },
  });
  useHostStyleVariables(app, app?.getHostContext());
  useHostFonts(app, app?.getHostContext());

  const defaultRunId = observedRunIdFromArgs(toolArgs) ?? runIdFromResult(toolResult);
  useEffect(() => {
    if (defaultRunId) setSelectedRunId(defaultRunId);
  }, [defaultRunId]);
  const runId = selectedRunId ?? defaultRunId;
  // Anchor the bounded listing on the viewed run so the server keeps it listed.
  const runs = useRecentRuns(app, runId, tornDown);
  const inlineSkeleton = useMemo(() => inlineSkeletonFromArgs(toolArgs), [toolArgs]);
  const skeletonRunId = runId ?? skeletonSourceRunIdFromArgs(toolArgs);
  const { model, connectionLost, disconnected, fatal } = useRunModel(
    app,
    runId,
    tornDown,
    runId !== undefined && runId === defaultRunId,
  );
  const skeleton = useSkeleton(app, skeletonRunId, inlineSkeleton);

  if (error) return <div className="log-empty">Failed to connect to host: {error.message}</div>;
  if (!app) return <div className="log-empty">Connecting…</div>;
  if (runId === undefined || !model) {
    // Foreground calls cannot reveal their server-assigned runId until their result. Inline run
    // input (or a resume source resource) still exposes the plan, so render it while waiting.
    const rejected = toolResult?.isError === true;
    if (skeleton !== undefined) {
      return <StartingSkeleton skeleton={skeleton} rejected={rejected} />;
    }
    if (rejected) return <div className="log-empty">Workflow was not admitted.</div>;
    if (toolArgs?.["action"] === "config" && toolResult !== null) {
      return <div className="log-empty">No workflow run for this configuration request.</div>;
    }
    return <div className="log-empty">Workflow starting…</div>;
  }
  return (
    <MonitorBody
      key={runId}
      app={app}
      model={model}
      skeleton={skeleton}
      connectionLost={connectionLost}
      disconnected={disconnected}
      fatal={fatal}
      runs={runs}
      onSelectRun={setSelectedRunId}
    />
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <RunMonitor />
  </StrictMode>,
);
