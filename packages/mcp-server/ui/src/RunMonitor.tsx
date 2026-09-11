import { App } from "@modelcontextprotocol/ext-apps";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import {
  useHostFonts,
  useHostStyleVariables,
} from "@modelcontextprotocol/ext-apps/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { DetailView } from "./DetailView.js";
import { fmtCost, fmtDuration, fmtTokens, shortRunId } from "./format.js";
import { GraphView } from "./GraphView.js";
import type { NodeSelection } from "./GraphView.js";
import {
  createModelMessageState,
  sendModelMessagesForFold,
  sendRequiredInputMessages,
  selectionContext,
  discussionMessage,
} from "./model-messages.js";
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
import { observedRunIdFromArgs } from "./tool-input.js";
import type { RunModel, RunStatus } from "./state.js";
import { readWorkflowEventsPage } from "./workflow-events-poll.js";
import type { EventsDoc } from "./workflow-events-poll.js";
import { readRecentRuns, type RunListItem } from "./workflow-runs.js";
import { RunActions, StopButton } from "./RunActions.js";
import { readRunStatus } from "./run-status.js";
import type { RunStatusSnapshot } from "./run-status.js";

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
  refresh: number,
  isCurrent: () => boolean,
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
    modelMessages.isCurrent = isCurrent;
    modelRef.current = createRunModel(runId);
    setFatal(undefined);
    setConnectionLost(false);
    setDisconnected(false);
    setVersion((version) => version + 1);

    const bump = () => setVersion((version) => version + 1);
    const schedule = (delayMs: number) => {
      if (cancelled || !isCurrent()) return;
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
        modelMessages.bootstrapEnd = undefined;
        modelMessages.highWaterSeq = 0;
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
      if (cancelled || !model || !isCurrent()) return;
      let doc: EventsDoc | undefined;
      try {
        doc = await readWorkflowEventsPage(app, {
          runId,
          after: model.cursor,
          streamId: model.streamId,
        });
        if (cancelled || !isCurrent()) return;
      } catch (error) {
        if (cancelled || !isCurrent()) return;
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

      if (modelMessages.bootstrapEnd === undefined)
        modelMessages.bootstrapEnd = doc.endCursor;
      if (model.streamId === undefined) {
        // Bootstrap read: adopt the stream generation and workflow name.
        model.streamId = doc.streamId;
        if (model.name === undefined && doc.workflowName)
          model.name = doc.workflowName;
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
      if (model.name === undefined && doc.workflowName)
        model.name = doc.workflowName;
      // Only the run this tool call belongs to narrates to the model; runs the user browses
      // through the navigator are app-local observation and must stay silent.
      if (narrateToModel)
        sendModelMessagesForFold(
          app,
          runId,
          doc.after,
          doc.events,
          modelMessages,
          doc.endCursor,
        );
      bump();

      if (doc.hasMore) {
        idleDelayMs = POLL_MS;
        schedule(0);
      } else if (!model.finalized || model.status === "paused") {
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
      modelMessages.active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [app, runId, tornDown, narrateToModel, refresh, isCurrent]);

  return {
    model:
      runId === undefined || modelRef.current?.runId !== runId
        ? null
        : modelRef.current,
    connectionLost,
    disconnected,
    fatal,
  };
}

function useRecentRuns(
  app: App | null,
  anchorRunId: string | undefined,
  tornDown: boolean,
): RunListItem[] {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  useEffect(() => {
    if (!app || !anchorRunId || tornDown) return;
    let cancelled = false;
    setRuns([]);
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
 * Build the graph only from the accepted run's persisted source. The wave view remains usable
 * when the host does not support resource reads or the source cannot be parsed.
 */
function useSkeleton(
  app: App | null,
  runId: string | undefined,
  tornDown: boolean,
): Skeleton | undefined {
  const [loaded, setLoaded] = useState<
    { runId: string; skeleton: Skeleton | undefined } | undefined
  >(undefined);
  useEffect(() => {
    if (!app || runId === undefined || tornDown) return;
    let cancelled = false;
    setLoaded(undefined);
    void (async () => {
      let skeleton: Skeleton | undefined;
      try {
        const result = await app.readServerResource({
          uri: `workflow://runs/${runId}/script`,
        });
        if (cancelled) return;
        const text = (result.contents as Array<{ text?: unknown }>).find(
          (content) => typeof content.text === "string",
        )?.text as string | undefined;
        if (text !== undefined) skeleton = extractSkeleton(text);
      } catch {
        // The timing-based wave graph needs no resource read.
      }
      if (!cancelled) setLoaded({ runId, skeleton });
    })();
    return () => {
      cancelled = true;
    };
  }, [app, runId, tornDown]);
  return runId !== undefined && loaded?.runId === runId
    ? loaded.skeleton
    : undefined;
}

function ElapsedClock({ model }: { model: RunModel }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (model.finalized) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [model.finalized]);
  if (model.startTs === undefined) return <span className="elapsed" />;
  const end =
    model.finalized && model.endTs !== undefined ? model.endTs : Date.now();
  return <span className="elapsed">{fmtDuration(end - model.startTs)}</span>;
}

function RunStatusChip({ status }: { status: RunStatus }) {
  switch (status) {
    case "pending":
      return <span className="chip chip-warn">Preparing</span>;
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

function MonitorBody({
  app,
  model,
  skeleton,
  connectionLost,
  disconnected,
  fatal,
  runs,
  onSelectRun,
  snapshot,
  statusError,
  onRefresh,
  onReconnect,
  hostContext,
  onDisplayMode,
}: {
  app: App;
  model: RunModel;
  skeleton: Skeleton | undefined;
  connectionLost: boolean;
  disconnected: boolean;
  fatal: string | undefined;
  runs: RunListItem[];
  onSelectRun: (runId: string) => void;
  snapshot: RunStatusSnapshot | undefined;
  statusError: string | undefined;
  onRefresh: () => void;
  onReconnect: () => void;
  hostContext: McpUiHostContext | undefined;
  onDisplayMode: (mode: "inline" | "fullscreen") => void;
}) {
  const [view, setView] = useState<
    { kind: "graph" } | { kind: "detail"; target: NodeSelection }
  >({
    kind: "graph",
  });
  const [expandedWaves, setExpandedWaves] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [loopSelections, setLoopSelections] = useState<
    ReadonlyMap<string, number>
  >(new Map());
  // Once the poll loop has given up for good the panel can no longer act on the run: freeze the
  // live affordances (Stop) and show a stale marker instead of the transient "reconnecting…".
  const live =
    !["completed", "failed", "aborted"].includes(model.status) && !disconnected;
  const bannerMessage = fatal ?? model.banner;
  const bannerIsError =
    fatal !== undefined ||
    model.status === "failed" ||
    model.status === "aborted";
  const usage = model.usage;
  const selected = view.kind === "detail" ? view.target : undefined;
  const selectedAgent =
    selected?.kind === "agent"
      ? model.nodes.get(selected.callIndex)
      : undefined;
  const context = selectionContext(model, selected, snapshot);
  const [deliveryError, setDeliveryError] = useState<string>();
  const [asking, setAsking] = useState(false);
  const askingRef = useRef(false);
  const activeRef = useRef(true);
  useEffect(
    () => () => {
      activeRef.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!app.getHostCapabilities()?.updateModelContext?.text) return;
    let active = true;
    const timer = setTimeout(() => {
      if (!active) return;
      void Promise.resolve()
        .then(() => {
          if (active)
            return app.updateModelContext({
              content: [{ type: "text", text: context }],
            });
        })
        .catch(() => {
          // Quiet context is optional and must never disable inspection or direct controls.
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [app, context]);
  const ask = async () => {
    if (askingRef.current) return;
    askingRef.current = true;
    setAsking(true);
    setDeliveryError(undefined);
    try {
      const result = await app.sendMessage({
        role: "user",
        content: [
          { type: "text", text: discussionMessage(model, selected, snapshot) },
        ],
      });
      if (result.isError)
        throw new Error("The host declined the discussion message.");
    } catch (error) {
      if (activeRef.current)
        setDeliveryError(
          error instanceof Error
            ? error.message
            : "The host could not deliver this message.",
        );
    } finally {
      askingRef.current = false;
      if (activeRef.current) setAsking(false);
    }
  };

  // The viewed run always stays selectable even when a bounded listing no longer includes it.
  const listedRuns: RunListItem[] = runs.some(
    (run) => run.runId === model.runId,
  )
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
  const activeRuns = listedRuns.filter(
    (run) =>
      run.status === "pending" ||
      run.status === "running" ||
      run.status === "paused",
  );
  const recentRuns = listedRuns.filter(
    (run) =>
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "aborted",
  );
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
                  <option key={run.runId} value={run.runId}>
                    {run.workflowName} · {run.status}
                  </option>
                ))}
              </optgroup>
            )}
            {recentRuns.length > 0 && (
              <optgroup label="Recent">
                {recentRuns.map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {run.workflowName} · {run.status}
                  </option>
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
          <span
            className="conn-lost"
            title="The run monitor stopped receiving updates."
          >
            disconnected — updates stopped
          </span>
        ) : (
          connectionLost && <span className="conn-lost">reconnecting…</span>
        )}
        {disconnected && <button onClick={onReconnect}>Reconnect</button>}
        {(hostContext?.displayMode === "fullscreen" ||
          hostContext?.availableDisplayModes?.includes("fullscreen")) && (
          <button
            onClick={() =>
              onDisplayMode(
                hostContext.displayMode === "fullscreen"
                  ? "inline"
                  : "fullscreen",
              )
            }
          >
            {hostContext.displayMode === "fullscreen"
              ? "Exit fullscreen"
              : "Expand"}
          </button>
        )}
        {live && (
          <StopButton app={app} runId={model.runId} onRefresh={onRefresh} />
        )}
      </header>
      {bannerMessage !== undefined && (
        <div className={`banner${bannerIsError ? " banner-error" : ""}`}>
          {bannerMessage}
        </div>
      )}
      <section className="inline-summary" aria-label="Run overview">
        <span>
          Phase:{" "}
          <strong>
            {model.phases.at(-1) ??
              (snapshot?.setup ? "Setup" : "Waiting for execution")}
          </strong>
        </span>
        <span>
          {
            [...model.nodes.values()].filter(
              (node) => node.status === "running",
            ).length
          }{" "}
          active agents
        </span>
        <div className="inline-agents">
          {[...model.nodes.values()]
            .filter((node) => node.status === "running")
            .slice(0, 6)
            .map((node) => (
              <button
                key={node.callIndex}
                onClick={() =>
                  setView({
                    kind: "detail",
                    target: { kind: "agent", callIndex: node.callIndex },
                  })
                }
              >
                {node.label}
              </button>
            ))}
        </div>
      </section>
      {statusError && (
        <div className="banner banner-error" role="alert">
          Controls need current status: {statusError}{" "}
          <button onClick={onRefresh}>Refresh status</button>
        </div>
      )}
      {!statusError && (
        <RunActions
          app={app}
          snapshot={snapshot}
          selected={selectedAgent}
          onRefresh={onRefresh}
        />
      )}
      <div className="selection-toolbar">
        {app.getHostCapabilities()?.message?.text && (
          <button disabled={asking} onClick={() => void ask()}>
            {asking
              ? "Sending…"
              : selected?.kind === "agent"
              ? "Ask about this agent"
              : selected?.kind === "phase"
              ? "Ask about this phase"
              : "Ask about this run"}
          </button>
        )}
        {deliveryError && (
          <span className="action-error" role="alert">
            {deliveryError}
          </span>
        )}
      </div>
      <div className="inspection-pane">
        <div
          className={
            view.kind === "graph" ? "graph-pane" : "graph-pane hidden-pane"
          }
          aria-hidden={view.kind !== "graph"}
        >
          <GraphView
            model={model}
            skeleton={skeleton}
            expandedWaves={expandedWaves}
            onExpandWave={(waveKey) =>
              setExpandedWaves((current) => new Set([...current, waveKey]))
            }
            loopSelections={loopSelections}
            onSelectLoopIteration={(loopId, iteration) =>
              setLoopSelections(
                (current) => new Map([...current, [loopId, iteration]]),
              )
            }
            onSelect={(target) => setView({ kind: "detail", target })}
          />
        </div>
        {view.kind === "detail" && (
          <DetailView
            key={JSON.stringify(view.target)}
            model={model}
            target={view.target}
            onBack={() => setView({ kind: "graph" })}
          />
        )}
      </div>
      <footer className="bar bottom">
        {view.kind === "graph" ? (
          <span className="hint">Select a node to inspect</span>
        ) : (
          <span className="hint" />
        )}
        <span className="spacer" />
        {usage !== undefined && (
          <span className="totals">
            <strong>{fmtTokens(usage.total)}</strong> tok {fmtCost(usage.cost)}
          </span>
        )}
      </footer>
    </>
  );
}

function useStatus(
  app: App,
  runId: string | undefined,
  tornDown: boolean,
  refresh: number,
  notify: boolean,
  isCurrent: () => boolean,
) {
  const [value, setValue] = useState<RunStatusSnapshot>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    // A refresh must retain the mounted input form and its exact-response retry identity.
    setValue((current) => (current?.runId === runId ? current : undefined));
    setError(undefined);
    if (!runId || tornDown) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const messages = createModelMessageState();
    messages.isCurrent = isCurrent;
    const poll = async () => {
      try {
        const snapshot = await readRunStatus(app, runId);
        if (cancelled || !isCurrent()) return;
        failures = 0;
        setValue(snapshot);
        setError(undefined);
        if (notify) sendRequiredInputMessages(app, snapshot, messages);
        if (!["completed", "failed", "aborted"].includes(snapshot.status))
          timer = setTimeout(() => void poll(), POLL_MS);
      } catch (failure) {
        if (cancelled || !isCurrent()) return;
        failures += 1;
        setError(
          failure instanceof Error ? failure.message : "Status is unavailable.",
        );
        if (!shouldGiveUp(failures))
          timer = setTimeout(
            () => void poll(),
            Math.min(15_000, POLL_MS * 2 ** failures),
          );
      }
    };
    void poll();
    return () => {
      cancelled = true;
      messages.active = false;
      clearTimeout(timer);
    };
  }, [app, runId, tornDown, refresh, notify, isCurrent]);
  return {
    snapshot: value?.runId === runId ? value : undefined,
    statusError: error,
  };
}

/** The complete production component accepts the same App interface in the deterministic host harness. */
export function RunMonitor({ app: injectedApp }: { app?: App } = {}) {
  const app = useMemo(
    () =>
      injectedApp ??
      new App({ name: "AgentPrism Run Monitor", version: "2.0.0" }, {}),
    [injectedApp],
  );
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [binding, setBinding] = useState<{ runId?: string; epoch: number }>({
    epoch: 0,
  });
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [tornDown, setTornDown] = useState(false);
  const [hostContext, setHostContext] = useState<McpUiHostContext>();
  const [displayError, setDisplayError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [reconnect, setReconnect] = useState(0);
  const life = useRef<{ epoch: number; active: boolean; runId?: string }>({
    epoch: 0,
    active: true,
  });
  useEffect(() => {
    let disposed = false;
    life.current.active = true;
    app.ontoolinput = (input) => {
      const runId = observedRunIdFromArgs(
        (input.arguments as Record<string, unknown> | undefined) ?? {},
      );
      life.current.epoch += 1;
      life.current.runId = runId;
      life.current.active = true;
      setBinding({ runId, epoch: life.current.epoch });
      setSelectedRunId(undefined);
      setError(
        runId
          ? undefined
          : "workflow_monitor requires an explicit existing runId.",
      );
      setTornDown(false);
      setDisplayError(undefined);
    };
    // Partial source input has no monitor lifecycle. A result never changes this instance's run.
    app.ontoolresult = (result) => {
      const runId = (
        result.structuredContent as { runId?: unknown } | undefined
      )?.runId;
      if (result.isError && runId === life.current.runId) {
        const text = result.content?.find((item) => item.type === "text");
        setError(
          text?.type === "text" ? text.text : "This run cannot be monitored.",
        );
      }
    };
    app.ontoolcancelled = () => {
      life.current.active = false;
      setTornDown(true);
      setError(
        "Monitor opening was cancelled. The workflow remains owned by the server; reopen its monitor to inspect it.",
      );
    };
    app.onhostcontextchanged = (context) =>
      setHostContext((current) => ({ ...current, ...context }));
    app.onteardown = async () => {
      life.current.active = false;
      setTornDown(true);
      return {};
    };
    app.onerror = () => {
      if (!disposed)
        setDisplayError(
          "The host connection reported an error. Current run data may be stale.",
        );
    };
    void app
      .connect()
      .then(() => {
        if (!disposed) {
          setReady(true);
          setHostContext(app.getHostContext());
        }
      })
      .catch((failure: unknown) => {
        if (!disposed)
          setError(
            `Failed to connect to host: ${
              failure instanceof Error ? failure.message : String(failure)
            }`,
          );
      });
    return () => {
      disposed = true;
      life.current.active = false;
      app.ontoolinput = undefined;
      app.ontoolresult = undefined;
      app.ontoolcancelled = undefined;
      app.onhostcontextchanged = undefined;
      app.onteardown = undefined;
      void app.close();
    };
  }, [app]);
  useHostStyleVariables(ready ? app : null, hostContext);
  useHostFonts(ready ? app : null, hostContext);
  const runId = selectedRunId ?? binding.runId;
  const epoch = binding.epoch;
  const isCurrent = useMemo(
    () => () => life.current.active && life.current.epoch === epoch,
    [epoch],
  );
  const observedRun = ready && !error ? runId : undefined;
  const runs = useRecentRuns(app, observedRun, tornDown);
  const { model, connectionLost, disconnected, fatal } = useRunModel(
    app,
    observedRun,
    tornDown,
    runId === binding.runId,
    reconnect,
    isCurrent,
  );
  const skeleton = useSkeleton(app, observedRun, tornDown);
  const { snapshot, statusError } = useStatus(
    app,
    observedRun,
    tornDown,
    refresh,
    runId === binding.runId,
    isCurrent,
  );
  const requestMode = async (mode: "inline" | "fullscreen") => {
    setDisplayError(undefined);
    const before = life.current.epoch;
    try {
      const response = await app.requestDisplayMode({ mode });
      if (!life.current.active || before !== life.current.epoch) return;
      setHostContext((current) => ({ ...current, displayMode: response.mode }));
      if (response.mode !== mode)
        setDisplayError(
          "The host kept the current display mode. All controls remain available here.",
        );
    } catch {
      if (life.current.active && before === life.current.epoch)
        setDisplayError(
          "Fullscreen is unavailable. All controls remain available here.",
        );
    }
  };
  const dimensions = hostContext?.containerDimensions;
  const style = {
    "--host-width":
      dimensions && "width" in dimensions ? `${dimensions.width}px` : "100%",
    "--host-max-width":
      dimensions && "maxWidth" in dimensions && dimensions.maxWidth
        ? `${dimensions.maxWidth}px`
        : "none",
    "--host-height":
      dimensions && "height" in dimensions
        ? `${dimensions.height}px`
        : hostContext?.displayMode === "fullscreen"
        ? "100dvh"
        : "520px",
    "--host-max-height":
      dimensions && "maxHeight" in dimensions && dimensions.maxHeight
        ? `${dimensions.maxHeight}px`
        : "none",
    "--safe-top": `${hostContext?.safeAreaInsets?.top ?? 0}px`,
    "--safe-right": `${hostContext?.safeAreaInsets?.right ?? 0}px`,
    "--safe-bottom": `${hostContext?.safeAreaInsets?.bottom ?? 0}px`,
    "--safe-left": `${hostContext?.safeAreaInsets?.left ?? 0}px`,
  } as CSSProperties;
  return (
    <main
      className={`monitor mode-${hostContext?.displayMode ?? "inline"}`}
      style={style}
      data-run-id={runId}
    >
      {displayError && (
        <div className="banner" role="status">
          {displayError}
        </div>
      )}
      {error ? (
        <div className="log-empty" role="alert">
          {error}
        </div>
      ) : tornDown ? (
        <div className="log-empty">
          Monitor closed. Reopen this run to keep observing it.
        </div>
      ) : !ready ? (
        <div className="log-empty">Connecting…</div>
      ) : !runId ? (
        <div className="log-empty">Waiting for workflow_monitor input…</div>
      ) : !model ? (
        <div className="log-empty">Loading run {runId}…</div>
      ) : (
        <MonitorBody
          key={`${epoch}:${runId}`}
          app={app}
          model={model}
          skeleton={skeleton}
          connectionLost={connectionLost}
          disconnected={disconnected}
          fatal={fatal}
          runs={runs}
          onSelectRun={(id) => {
            life.current.runId = id;
            life.current.epoch += 1;
            setBinding((current) => ({
              ...current,
              epoch: life.current.epoch,
            }));
            setSelectedRunId(id);
          }}
          snapshot={snapshot}
          statusError={statusError}
          onRefresh={() => setRefresh((value) => value + 1)}
          onReconnect={() => {
            setReconnect((value) => value + 1);
            setRefresh((value) => value + 1);
          }}
          hostContext={hostContext}
          onDisplayMode={(mode) => void requestMode(mode)}
        />
      )}
    </main>
  );
}
