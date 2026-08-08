// Folds the append-only run event log (workflow-events pages) into the render model.
// Records arrive in seq order within a stream; a stream change (delete/recreate) resets
// the whole model, and agentStart for an already-known callIndex resets that node
// (resume re-execution starts a fresh transcript partition).
import type {
  AgentHistoryEntry,
  PersistedRunEvent,
  RunEventLogRecord,
  TokenUsage,
} from "@automatalabs/shared-types";

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
export type NodeStatus = "running" | "done" | "error";

export interface DetailRow {
  ts?: number;
  order: number;
  kind: "text" | "tool" | "tool-result" | "error" | "log";
  text: string;
  meta?: string;
  isError?: boolean;
  /** Paired tool output (from the matching toolResult entry), shown as a click-to-expand block. */
  detail?: { text: string; isError?: boolean };
}

export interface NodeModel {
  callIndex: number;
  label: string;
  phase?: string;
  /** The REQUESTED model spec (e.g. "opus[1m]") — kept verbatim for display. */
  model?: string;
  /** The backend-resolved model id, when the run reported one. */
  modelResolved?: string;
  backendId?: string;
  /** Engine structural call path (agentStart.path) — joins the node to a skeleton site. */
  path?: string;
  /** Originating engine run; the skeleton join only applies when scope === RunModel.runId
   *  (workflow() children share the stream but execute a different script). */
  scope?: string;
  status: NodeStatus;
  startSeq: number;
  startTs?: number;
  endTs?: number;
  tokens?: number;
  costUsd?: number;
  resultPreview?: string;
  errorText?: string;
  errorCode?: string;
  /** Durable in-flight transcript upserts keyed by executionStartSeq:entryIndex. */
  transcript: Map<string, { row: DetailRow; revision: number }>;
  /** Coarse progress rows used only when no transcript entries exist for the node. */
  progress: DetailRow[];
}

export interface CheckpointModel {
  callIndex: number;
  path?: string;
  scope?: string;
  outcome: "result" | "null" | "error";
}

export interface RunModel {
  runId: string;
  streamId?: string;
  cursor: number;
  name?: string;
  status: RunStatus;
  finalized: boolean;
  startTs?: number;
  endTs?: number;
  phases: string[];
  /** Every phase() transition in stream order, for slicing run logs per phase. */
  phaseMarks: Array<{ title: string; seq: number; ts?: number }>;
  nodes: Map<number, NodeModel>;
  /** Settled checkpoint() calls (from callRecord events) — checkpoints emit no agentStart. */
  checkpoints: Map<number, CheckpointModel>;
  logs: DetailRow[];
  usage?: TokenUsage;
  agentCountFinal?: number;
  /** One-line paused/failed/stopped explanation shown in the banner strip. */
  banner?: string;
}

export function createRunModel(runId: string): RunModel {
  return {
    runId,
    cursor: 0,
    status: "pending",
    finalized: false,
    phases: [],
    phaseMarks: [],
    nodes: new Map(),
    checkpoints: new Map(),
    logs: [],
  };
}

/**
 * Seed a minimal render model for the STATIC fallback host class — a host that serves neither
 * app-originated resource reads (so the event poll is impossible) nor the pi push channel. The panel
 * cannot build a live graph there; it shows only what the tool call itself delivered: the runId
 * always, plus the status and workflow name when the result carried them (foreground calls return a
 * terminal status; background calls return "running"). The panel renders an honest "live updates
 * aren't supported by this host" state around this seed instead of the reconnect spinner.
 */
export function seedStaticRunModel(
  runId: string,
  seed?: { status?: RunStatus; workflowName?: string },
): RunModel {
  const model = createRunModel(runId);
  if (seed?.status !== undefined) {
    model.status = seed.status;
    model.finalized = seed.status === "completed" || seed.status === "failed" || seed.status === "aborted";
  }
  if (seed?.workflowName !== undefined) model.name = seed.workflowName;
  return model;
}

function rowFromHistoryEntry(entry: AgentHistoryEntry, order: number, fallbackTs?: number): DetailRow {
  const kind =
    entry.kind === "toolCall"
      ? "tool"
      : entry.kind === "toolResult"
        ? "tool-result"
        : entry.kind === "error" || entry.isError
          ? "error"
          : "text";
  const row: DetailRow = {
    order,
    kind,
    text: entry.text || entry.toolName || "",
  };
  const ts = entry.timestamp ?? fallbackTs;
  if (ts !== undefined) row.ts = ts;
  if (entry.toolName !== undefined) row.meta = entry.toolName;
  if (entry.isError === true) row.isError = true;
  return row;
}

/**
 * Attach each toolResult row to the nearest preceding unresolved toolCall row with the same
 * tool name (results without a tool name pair with the most recent open call). Unmatched
 * results stay standalone. Parallel same-tool calls can pair to the adjacent sibling — both
 * stay visible in order, so the ambiguity is cosmetic.
 */
function pairToolRows(rows: DetailRow[]): DetailRow[] {
  const paired: DetailRow[] = [];
  const openCalls: DetailRow[] = [];
  for (const row of rows) {
    if (row.kind === "tool") {
      const copy = { ...row };
      paired.push(copy);
      openCalls.push(copy);
      continue;
    }
    if (row.kind === "tool-result") {
      let matched = -1;
      for (let index = openCalls.length - 1; index >= 0; index--) {
        if (row.meta === undefined || openCalls[index]?.meta === row.meta) {
          matched = index;
          break;
        }
      }
      if (matched >= 0) {
        const call = openCalls[matched];
        if (call) {
          call.detail = { text: row.text, ...(row.isError === true ? { isError: true } : {}) };
          if (row.isError === true) call.isError = true;
          openCalls.splice(matched, 1);
          continue;
        }
      }
    }
    paired.push(row);
  }
  return paired;
}

/** Ordered rows for the node detail view: transcript when present, progress otherwise. */
export function nodeRows(node: NodeModel): DetailRow[] {
  if (node.transcript.size > 0) {
    return pairToolRows(
      [...node.transcript.values()]
        .map((held) => held.row)
        .sort((left, right) => left.order - right.order),
    );
  }
  return node.progress;
}

function asPreview(value: unknown): string | undefined {
  if (value && typeof value === "object" && "preview" in value) {
    const preview = (value as { preview: unknown }).preview;
    if (typeof preview === "string") return preview;
  }
  return undefined;
}

export function foldRecord(model: RunModel, record: RunEventLogRecord): void {
  const ts = Date.parse(record.timestamp);
  const at = Number.isFinite(ts) ? ts : undefined;
  if (at !== undefined && model.startTs === undefined) model.startTs = at;
  const event = record.event as PersistedRunEvent;

  switch (event.type) {
    case "phase": {
      if (model.phases.at(-1) !== event.title) model.phases.push(event.title);
      model.phaseMarks.push({ title: event.title, seq: record.seq, ...(at !== undefined ? { ts: at } : {}) });
      return;
    }
    case "agentStart": {
      const node: NodeModel = {
        callIndex: event.callIndex,
        label: event.label,
        status: "running",
        startSeq: record.seq,
        transcript: new Map(),
        progress: [],
      };
      if (event.phase !== undefined) node.phase = event.phase;
      if (event.model !== undefined) node.model = event.model;
      if (event.path !== undefined) node.path = event.path;
      node.scope = event.scope;
      if (at !== undefined) node.startTs = at;
      model.nodes.set(event.callIndex, node);
      return;
    }
    case "agentEnd": {
      const node = model.nodes.get(event.callIndex);
      if (!node) return;
      node.status = event.error !== undefined || event.errorCode !== undefined ? "error" : "done";
      if (at !== undefined) node.endTs = at;
      if (event.tokens !== undefined) node.tokens = event.tokens;
      if (event.usage?.cost !== undefined) node.costUsd = event.usage.cost;
      if (event.usage?.total !== undefined && node.tokens === undefined) node.tokens = event.usage.total;
      if (event.modelResolved !== undefined) node.modelResolved = event.modelResolved;
      if (node.model === undefined && event.model !== undefined) node.model = event.model;
      if (event.backendId !== undefined) node.backendId = event.backendId;
      const preview = asPreview(event.result);
      if (preview !== undefined) node.resultPreview = preview;
      if (event.error !== undefined) node.errorText = event.error;
      if (event.errorCode !== undefined) node.errorCode = event.errorCode;
      return;
    }
    case "agentProgress": {
      const node = model.nodes.get(event.callIndex);
      if (!node) return;
      const text = event.lastToolName !== undefined ? event.lastToolName : (event.latestText ?? "");
      if (!text) return;
      const last = model.nodes.get(event.callIndex)?.progress.at(-1);
      if (last && last.text === text) return;
      const row: DetailRow = {
        order: record.seq,
        kind: event.lastToolName !== undefined ? "tool" : "text",
        text,
      };
      if (at !== undefined) row.ts = at;
      if (event.lastToolName !== undefined) row.meta = event.lastToolName;
      node.progress.push(row);
      return;
    }
    case "agentTranscript": {
      const node = model.nodes.get(event.callIndex);
      if (!node) return;
      const key = `${event.executionStartSeq}:${event.entryIndex}`;
      const existing = node.transcript.get(key);
      if (existing && existing.revision >= event.revision) return;
      node.transcript.set(key, {
        revision: event.revision,
        // Order by execution partition first, then entry index within it.
        row: rowFromHistoryEntry(event.entry, event.executionStartSeq * 100_000 + event.entryIndex, at),
      });
      return;
    }
    case "callRecord": {
      const call = event.record;
      if (call.kind === "checkpoint") {
        const checkpoint: CheckpointModel = { callIndex: call.index, outcome: call.outcome };
        if (call.path !== undefined) checkpoint.path = call.path;
        checkpoint.scope = event.scope;
        model.checkpoints.set(call.index, checkpoint);
        return;
      }
      // Agents: backfill the call path for streams recorded before agentStart carried it.
      const node = model.nodes.get(call.index);
      if (node !== undefined && node.path === undefined && call.path !== undefined) {
        node.path = call.path;
      }
      return;
    }
    case "log": {
      const row: DetailRow = { order: record.seq, kind: "log", text: event.message };
      if (at !== undefined) row.ts = at;
      model.logs.push(row);
      return;
    }
    case "tokenUsage": {
      model.usage = event.usage;
      return;
    }
    case "complete": {
      model.status = "completed";
      model.finalized = true;
      if (at !== undefined) model.endTs = at;
      const summary = event.summary;
      if (model.name === undefined) model.name = summary.workflowName;
      model.agentCountFinal = summary.agentCount;
      if (model.usage === undefined && summary.tokenUsage !== undefined) model.usage = summary.tokenUsage;
      delete model.banner;
      return;
    }
    case "paused": {
      model.status = "paused";
      if (event.reason === "auth_required") {
        const backend = event.authContext?.backendId;
        model.banner = `Paused: authentication required${backend ? ` for backend "${backend}"` : ""}. Log in on this machine, then resume.`;
      } else if (event.reason === "checkpoint_required") {
        const prompt = event.checkpointContext?.prompt;
        model.banner = `Paused: awaiting a ${event.checkpointContext?.kind ?? "checkpoint"} decision${prompt ? ` — ${prompt}` : ""}.`;
      } else if (event.reason === "usage_limit") {
        model.banner = `Paused: usage limit reached${event.resetHint ? ` — ${event.resetHint}` : ""}.`;
      } else {
        model.banner = "Paused.";
      }
      return;
    }
    case "error": {
      model.status = "failed";
      model.finalized = true;
      if (at !== undefined) model.endTs = at;
      const message = event.errorRecord.message;
      model.banner = `Failed${message ? `: ${message}` : ""}`;
      return;
    }
    case "stopped": {
      model.status = "aborted";
      model.finalized = true;
      if (at !== undefined) model.endTs = at;
      model.banner = "Run stopped.";
      return;
    }
    case "resumed": {
      model.status = "running";
      model.finalized = false;
      delete model.banner;
      return;
    }
    default:
      return;
  }
}

/** Live agent count: final count once complete, otherwise nodes seen so far. */
export function agentCount(model: RunModel): number {
  return model.agentCountFinal ?? model.nodes.size;
}
