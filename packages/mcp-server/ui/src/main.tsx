// Run-monitor panel entrypoint (React, @modelcontextprotocol/ext-apps/react).
//
// Rendered by MCP Apps hosts for `workflow` tool calls (the tool carries
// _meta.ui.resourceUri). The panel derives the runId from whichever arrives first:
//   - tool ARGUMENTS for action inspect/await/stop (runId is an input), or
//   - the tool RESULT's structuredContent.runId for execute calls (background admission
//     returns it immediately; foreground returns it with the terminal result).
// Once a runId is known the panel keeps itself live by polling the events RESOURCE
// (`workflow://runs/{runId}/events`, ~2s while the run is live, adaptive backoff when idle and
// on faults) and folding each page into the render model — the model/host are not involved
// again. A resource read is used, not the `workflow-events` tool, because some Apps-capable
// hosts narrate every app-originated tools/call into the model's conversation while leaving
// resource reads silent; the tool stays registered for other clients. Stop issues `workflow`
// action:"stop" through the host bridge.
import type { App } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostFonts, useHostStyleVariables } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RunEventLogRecord } from "@automatalabs/shared-types";

import { DetailView } from "./DetailView.js";
import { fmtCost, fmtDuration, fmtTokens, shortRunId } from "./format.js";
import { GraphView } from "./GraphView.js";
import type { NodeSelection } from "./GraphView.js";
import {
  buildModelContextSnapshot,
  formatModelContextText,
  hasFoldedEvents,
  isUrgentStatus,
  modelContextPushKey,
  nextPushDelayMs,
} from "./model-context.js";
import {
  getPiStreamHostContext,
  parseUiResultPatch,
  PiStreamFold,
} from "./pi-stream.js";
import { nextErrorBackoffMs, nextIdleDelayMs, POLL_MS, shouldGiveUp } from "./poll-backoff.js";
import { classifyReadError } from "./read-error.js";
import { extractSkeleton } from "./skeleton.js";
import type { Skeleton } from "./skeleton.js";
import { agentCount, createRunModel, foldRecord, seedStaticRunModel } from "./state.js";
import type { RunModel, RunStatus } from "./state.js";
import "./style.css";

/**
 * The live-update channel the panel resolved for this host:
 *   - "resource": the events resource read works — the primary channel, polled every ~2s. Its
 *     behavior is unchanged from a resource-capable host; the two other modes only ever engage on
 *     hosts where the resource read is impossible.
 *   - "stream": a pi (pi-mcp-adapter) eager stream — the server pushes cursor-bearing event windows
 *     as notifications and the panel folds them; no polling of any kind.
 *   - "static": the host serves neither app-originated resource reads nor the pi stream — the panel
 *     renders from the tool delivery alone and states honestly that live updates are unsupported.
 */
type HostMode = "resource" | "stream" | "static";

/** Banner shown in the static fallback: honest, and never the transient reconnect spinner. */
const STATIC_UNSUPPORTED_MESSAGE = "Live updates aren't supported by this host; showing the last delivered state.";

interface EventsDoc {
  schemaVersion: number;
  runId: string;
  streamId: string;
  workflowName: string;
  status: RunStatus;
  finalized: boolean;
  after: number;
  cursor: number;
  endCursor: number;
  hasMore: boolean;
  events: unknown[];
}

// Per-page cursor read size (server caps limit at 1000). Catch-up paging chains reads via hasMore.
// POLL_MS / MAX_BACKOFF_MS / MAX_POLL_FAILURES and the backoff policy live in poll-backoff.ts.
const PAGE_LIMIT = 500;

function runIdFromArgs(args: Record<string, unknown> | null): string | undefined {
  const runId = args?.["runId"];
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

function runIdFromResult(result: CallToolResult | null): string | undefined {
  const structured = result?.structuredContent as { runId?: unknown } | undefined;
  return typeof structured?.runId === "string" && structured.runId.length > 0
    ? structured.runId
    : undefined;
}

function budgetFromResult(result: CallToolResult | null): number | null | undefined {
  const structured = result?.structuredContent as
    | { limits?: { tokenBudget?: unknown } }
    | undefined;
  const budget = structured?.limits?.tokenBudget;
  return typeof budget === "number" || budget === null ? budget : undefined;
}

const RUN_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "aborted",
];

/**
 * Extract the static-fallback seed from a tool result's structuredContent — the run status and
 * workflow name a resource-less host still delivers (foreground calls return a terminal status;
 * background calls return "running"). Used only when the panel resolves the static host class; on
 * every live-channel host the event stream supersedes it.
 */
function staticSeedFromResult(result: CallToolResult | null): StaticSeed | undefined {
  const structured = result?.structuredContent as
    | { status?: unknown; workflowName?: unknown }
    | undefined;
  if (!structured) return undefined;
  const seed: StaticSeed = {};
  if (RUN_STATUSES.includes(structured.status as RunStatus)) seed.status = structured.status as RunStatus;
  if (typeof structured.workflowName === "string") seed.workflowName = structured.workflowName;
  return seed.status === undefined && seed.workflowName === undefined ? undefined : seed;
}

/** Parse the events resource read into the shared document, mirroring the skeleton read's shape. */
function eventsDocFromResource(result: { contents: readonly unknown[] }): EventsDoc | undefined {
  const text = (result.contents as Array<{ text?: unknown }>).find(
    (content) => typeof content.text === "string",
  )?.text as string | undefined;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as EventsDoc;
  } catch {
    return undefined;
  }
}

interface MonitorState {
  model: RunModel | null;
  connectionLost: boolean;
  /** Latched once the poll loop gives up for good (bounded consecutive faults); render is stale. */
  disconnected: boolean;
  fatal: string | undefined;
  /** The live-update channel resolved for this host (see HostMode). */
  mode: HostMode;
}

/** Static-fallback seed extracted from the tool call's own delivery (the only data such a host gives). */
interface StaticSeed {
  status?: RunStatus;
  workflowName?: string;
}

/**
 * Poll the events RESOURCE into a fold-model; re-renders by bumping a version counter.
 * `tornDown` stops the loop for good once the host tears the panel down, so a replaced or
 * dismissed panel cannot keep reading from the server from a detached iframe.
 *
 * A resource read (not the `workflow-events` tool) is used because some Apps-capable hosts narrate
 * every app-originated tools/call into the model's conversation but leave resource reads silent.
 * The panel discovers the stream generation with one canonical read, then pages by cursor with the
 * explicit streamId the query form requires. Idle polls back off (2s→4s→8s→cap) and reset on new
 * events; a bounded run of read faults gives up for good rather than retrying a dead run forever.
 */
function useRunModel(
  app: App | null,
  runId: string | undefined,
  tornDown: boolean,
  staticSeed: StaticSeed | undefined,
): MonitorState {
  const modelRef = useRef<RunModel | null>(null);
  const [, setVersion] = useState(0);
  const [connectionLost, setConnectionLost] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [fatal, setFatal] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<HostMode>("resource");
  // The seed is read once when the panel resolves the static fallback; keep it in a ref so the effect
  // (keyed on app/runId/tornDown) does not re-run — and re-latch — every time the tool result mutates.
  const staticSeedRef = useRef<StaticSeed | undefined>(staticSeed);
  staticSeedRef.current = staticSeed;

  useEffect(() => {
    if (!app || runId === undefined || tornDown) return;
    let cancelled = false;
    modelRef.current = createRunModel(runId);
    setFatal(undefined);
    setConnectionLost(false);
    setDisconnected(false);
    setVersion((version) => version + 1);
    const bump = () => setVersion((version) => version + 1);

    // --- Host classification, positive fast path: pi advertises its push channel in hostContext. ---
    const piStream = getPiStreamHostContext(app.getHostContext() as Record<string, unknown> | undefined);

    // Shared pi-stream fold path, reused whether the channel is discovered via hostContext (below) or
    // via a late ui-result-patch notification arriving in resource/static mode.
    let fold: PiStreamFold | undefined;
    const previousNotificationHandler = app.fallbackNotificationHandler;
    const restoreNotificationHandler = () => {
      app.fallbackNotificationHandler = previousNotificationHandler;
    };

    const enterStreamMode = (uiStreamId: string) => {
      // Discard any resource-poll fault state — the pi stream is the live channel now, not a fallback.
      setConnectionLost(false);
      setDisconnected(false);
      fold = new PiStreamFold(uiStreamId);
      setMode("stream");
    };

    const foldFrame = (notification: unknown): void => {
      const parsed = parseUiResultPatch(notification);
      if (parsed === undefined) return;
      // A ui-result-patch arriving without a prior hostContext advertisement (belt-and-suspenders for
      // "OR ui-result-patch notifications arrive"): adopt the stream on the first frame.
      if (fold === undefined) enterStreamMode(parsed.envelope.streamId);
      const model = modelRef.current;
      if (model && fold && fold.fold(model, parsed)) bump();
    };

    // Install the notification handler for BOTH modes: in stream mode it is the only channel; in
    // resource/static mode it lets a late pi frame upgrade the panel to the stream. A resource-capable
    // host never emits these, so the resource poll below stays byte-identical there.
    app.fallbackNotificationHandler = async (notification) => {
      if (!cancelled) foldFrame(notification);
      await previousNotificationHandler?.(notification);
    };

    if (piStream) {
      // pi eager stream: no polling of any kind (an app-originated read is -32601 and every
      // app-originated tools/call would wake the agent). Fold server-pushed windows only.
      enterStreamMode(piStream.streamId);
      return () => {
        cancelled = true;
        restoreNotificationHandler();
      };
    }

    // --- Resource poll path (primary channel on capable hosts; unchanged behavior there). ---
    setMode("resource");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let backoffMs = POLL_MS;
    let idleDelayMs = POLL_MS;
    let consecutiveFailures = 0;
    let finalConfirmDone = false;

    const schedule = (delayMs: number) => {
      if (cancelled || fold !== undefined) return;
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
    const enterStaticMode = () => {
      // A host that answers app-originated resource reads with -32601 will never serve them: this is
      // a permanent host property, NOT a transient fault. Stop the poll for good, drop any spinner,
      // and render the honest static state seeded from the tool delivery.
      if (timer !== undefined) clearTimeout(timer);
      setConnectionLost(false);
      setDisconnected(false);
      modelRef.current = seedStaticRunModel(runId, staticSeedRef.current);
      setMode("static");
      bump();
    };
    const eventsUri = (streamId: string | undefined): string =>
      streamId === undefined
        ? // Bootstrap: canonical read has no query and returns the current streamId without
          // requiring one (the query form mandates streamId, unknown until the first read lands).
          `workflow://runs/${runId}/events`
        : `workflow://runs/${runId}/events?after=${modelRef.current?.cursor ?? 0}&limit=${PAGE_LIMIT}&streamId=${streamId}`;

    const onReadError = (error: unknown): void => {
      switch (classifyReadError(error)) {
        case "stream-rebuild":
          // Stream generation changed (run deleted/recreated): rebuild and re-bootstrap the stream.
          modelRef.current = createRunModel(runId);
          consecutiveFailures = 0;
          idleDelayMs = POLL_MS;
          bump();
          schedule(POLL_MS);
          return;
        case "run-not-found":
          setFatal("This run is no longer present in the run store.");
          return;
        case "host-no-app-resources":
          enterStaticMode();
          return;
        default:
          degrade();
      }
    };

    const poll = async (): Promise<void> => {
      const model = modelRef.current;
      if (cancelled || fold !== undefined || !model) return;
      let doc: EventsDoc | undefined;
      try {
        const result = await app.readServerResource({ uri: eventsUri(model.streamId) });
        if (cancelled || fold !== undefined) return;
        doc = eventsDocFromResource(result);
      } catch (error) {
        if (cancelled || fold !== undefined) return;
        onReadError(error);
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

      for (const record of doc.events) foldRecord(model, record as RunEventLogRecord);
      model.cursor = doc.cursor;
      model.status = doc.status;
      model.finalized = doc.finalized;
      if (model.name === undefined && doc.workflowName) model.name = doc.workflowName;
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
      restoreNotificationHandler();
    };
  }, [app, runId, tornDown]);

  return {
    model: runId === undefined ? null : modelRef.current,
    connectionLost,
    disconnected,
    fatal,
    mode,
  };
}

/**
 * Mirror run status into the host's model context (`ui/update-model-context`) so the agent
 * learns of phase transitions, failures, pauses, and the terminal state without re-calling
 * the `workflow` tool — every model-initiated call renders another panel instance. Pushes
 * overwrite each other, fire only when the run's signature changes, are throttled on the
 * trailing edge for routine transitions, and go out immediately for paused/terminal ones.
 * A host that rejects the request (feature unsupported) disables the channel for good.
 */
function useModelContextSync(app: App | null, model: RunModel | null, tornDown: boolean): void {
  // Key the effect on the push key, not the milestone signature alone: the folded bit is part of
  // the trigger so React re-runs the effect the instant the first events page folds — otherwise a
  // first page that only sets the name and starts an agent (no milestone) would not move the
  // signature and the held-back initial snapshot would wait until the next milestone.
  const pushKey = model === null ? undefined : modelContextPushKey(model);
  const modelRef = useRef<RunModel | null>(model);
  modelRef.current = model;
  const disabledRef = useRef(false);
  const lastPushRef = useRef(0);

  useEffect(() => {
    if (!app || pushKey === undefined || disabledRef.current || tornDown) return;
    const current = modelRef.current;
    // Hold every push until at least one events page has folded. The effect seeds an empty model
    // and bumps a render before the first page lands; pushing that seed would leak the "workflow"
    // name fallback and an agents-settled 0/0 into the model's context ahead of real data.
    if (!current || !hasFoldedEvents(current)) return;
    const wait = nextPushDelayMs(isUrgentStatus(current), lastPushRef.current, Date.now());
    // Trailing-edge timer: superseded signatures cancel, so only the latest state lands.
    const timer = setTimeout(() => {
      const latest = modelRef.current;
      if (!latest || disabledRef.current) return;
      lastPushRef.current = Date.now();
      void app
        .updateModelContext({
          content: [{ type: "text", text: formatModelContextText(latest) }],
          structuredContent: { ...buildModelContextSnapshot(latest) },
        })
        .catch(() => {
          disabledRef.current = true;
        });
    }, wait);
    return () => clearTimeout(timer);
  }, [app, pushKey, tornDown]);
}

/**
 * Fetch the run's admitted script and extract its structural skeleton. Any failure — the
 * host not supporting resource reads, the resource missing, an unparseable script — yields
 * undefined and the graph falls back to the timing-based wave layout.
 */
function useSkeleton(app: App | null, runId: string | undefined): Skeleton | undefined {
  const [skeleton, setSkeleton] = useState<Skeleton | undefined>(undefined);
  useEffect(() => {
    if (!app || runId === undefined) return;
    let cancelled = false;
    setSkeleton(undefined);
    // A pi (or any) host that advertises the push channel has no app-originated resource reads, so
    // the script read is a guaranteed -32601. Skip it entirely and let the graph use the timing-based
    // wave layout — hide the skeleton-derived preview gracefully rather than firing a doomed read.
    if (getPiStreamHostContext(app.getHostContext() as Record<string, unknown> | undefined)) {
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const result = await app.readServerResource({ uri: `workflow://runs/${runId}/script` });
        if (cancelled) return;
        const text = (result.contents as Array<{ text?: unknown }>).find(
          (content) => typeof content.text === "string",
        )?.text as string | undefined;
        if (text !== undefined) setSkeleton(extractSkeleton(text));
      } catch (error) {
        // Classify the failure the same way the events poll does rather than swallowing it blindly.
        // A host with no app-originated resource reads answers this script read with -32601 exactly
        // as it does the events read (host-no-app-resources): a permanent host property, so hide the
        // skeleton-derived layout GRACEFULLY (the graph falls back to the timing-based wave view)
        // instead of surfacing an error. Missing/unparseable scripts degrade the same silent way.
        void classifyReadError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app, runId]);
  return runId === undefined ? undefined : skeleton;
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
  budget,
  mode,
}: {
  app: App;
  model: RunModel;
  skeleton: Skeleton | undefined;
  connectionLost: boolean;
  disconnected: boolean;
  fatal: string | undefined;
  budget: number | null | undefined;
  mode: HostMode;
}) {
  const [view, setView] = useState<{ kind: "graph" } | { kind: "detail"; target: NodeSelection }>({
    kind: "graph",
  });
  const [expandedWaves, setExpandedWaves] = useState<ReadonlySet<string>>(new Set());
  const [loopSelections, setLoopSelections] = useState<ReadonlyMap<string, number>>(new Map());

  // Once the poll loop has given up for good the panel can no longer act on the run: freeze the
  // live affordances (Stop) and show a stale marker instead of the transient "reconnecting…".
  const live = !model.finalized && model.status !== "completed" && !disconnected;
  // The static fallback host has no live channel: state honestly that updates are unsupported rather
  // than ever showing the reconnect spinner. run-store-fatal / paused-failed banners still win.
  const bannerMessage =
    fatal ?? model.banner ?? (mode === "static" ? STATIC_UNSUPPORTED_MESSAGE : undefined);
  const bannerIsError =
    fatal !== undefined || model.status === "failed" || model.status === "aborted";
  const usage = model.usage;

  return (
    <>
      <header className="bar top">
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
            {budget !== undefined && budget !== null ? ` / ${fmtTokens(budget)} tok` : " tok"}
            {"  "}
            {fmtCost(usage.cost)}
          </span>
        )}
      </footer>
    </>
  );
}

function RunMonitor() {
  const [toolArgs, setToolArgs] = useState<Record<string, unknown> | null>(null);
  const [toolResult, setToolResult] = useState<CallToolResult | null>(null);
  // The host tears the panel down when its session completes or the user dismisses it. Latch
  // it so every outbound channel (event polling, model-context pushes) stops permanently.
  const [tornDown, setTornDown] = useState(false);

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

  const runId = runIdFromArgs(toolArgs) ?? runIdFromResult(toolResult);
  const staticSeed = staticSeedFromResult(toolResult);
  const { model, connectionLost, disconnected, fatal, mode } = useRunModel(
    app,
    runId,
    tornDown,
    staticSeed,
  );
  const skeleton = useSkeleton(app, runId);
  const budget = budgetFromResult(toolResult);
  useModelContextSync(app, model, tornDown);

  if (error) return <div className="log-empty">Failed to connect to host: {error.message}</div>;
  if (!app) return <div className="log-empty">Connecting…</div>;
  if (runId === undefined || !model) {
    // Execute calls reveal the runId in their result: instantly for background admissions,
    // at termination for foreground runs. Until then there is nothing to monitor yet.
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
      budget={budget}
      mode={mode}
    />
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <RunMonitor />
  </StrictMode>,
);
