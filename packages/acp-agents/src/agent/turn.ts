// The per-turn collector and the AcpAgentTurn builder. A collector taps the agent's bus for the
// duration of one `session/prompt` (the drain contract guarantees every update of the turn is
// delivered before the prompt resolves), storing verbatim clones of every session/update and raw
// vendor notification, the final permission/elicitation decisions, and a tool-call fold keyed by
// toolCallId. `buildTurn` derives text, history slice, usage, and the structured result.
import type { PromptResponse, ToolCallContent, ToolCallLocation, ToolCallStatus, ToolKind } from "@agentclientprotocol/sdk";
import type { AgentHistoryEntry, AgentUsage } from "@automatalabs/shared-types";
import type { TSchema } from "typebox";
import type { Backend } from "../backend.js";
import type { AcpElicitationEvent, AcpPermissionEvent, AcpSessionUpdate } from "../events.js";
import type { UsageBaseline } from "../usage.js";
import type { AgentEventBus } from "./events.js";
import { resolveTurnStructured, type StructuredHandle } from "./structured.js";
import type {
  AcpAgentRawRecord,
  AcpAgentToolCall,
  AcpAgentTurn,
  AcpAgentTurnUsage,
  AcpAgentUpdateRecord,
} from "./types.js";

/** The slice of a SessionHandle the collector and builder read (duck-typed for unit tests). */
export interface TurnHandle extends StructuredHandle {
  readonly history: AgentHistoryEntry[];
  readonly usage: { baseline(): UsageBaseline };
  foldedTurnText(): string;
}

interface MutableToolCall {
  toolCallId: string;
  name?: string;
  title: string;
  kind?: ToolKind;
  status: ToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  meta?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class TurnCollector {
  readonly historyStart: number;
  readonly gaugeBefore: UsageBaseline;
  readonly updates: AcpAgentUpdateRecord[] = [];
  readonly raw: AcpAgentRawRecord[] = [];
  readonly permissions: AcpPermissionEvent[] = [];
  readonly elicitations: AcpElicitationEvent[] = [];
  readonly #toolCalls = new Map<string, MutableToolCall>();
  #active = true;
  readonly #untap: () => void;

  /** Registers the tap SYNCHRONOUSLY — construct before the wire call so nothing is missed.
   *  `retainHistory: false` (the session's `retainSessionLog: false`) means the handle CLEARS its
   *  accumulator at `beginTurn()`, so this turn's slice starts at 0, not at the previous length. */
  constructor(bus: Pick<AgentEventBus, "tap">, handle: TurnHandle, options: { retainHistory?: boolean } = {}) {
    this.historyStart = options.retainHistory === false ? 0 : handle.history.length;
    this.gaugeBefore = handle.usage.baseline();
    this.#untap = bus.tap((name, event) => {
      if (!this.#active) return;
      switch (name) {
        case "session_update": {
          const update = structuredClone((event as { update: AcpSessionUpdate }).update);
          this.updates.push({ update, receivedAt: Date.now() });
          this.#foldToolCall(update);
          return;
        }
        case "raw_message": {
          const { method, message } = event as { method: string; message: unknown };
          this.raw.push({ method, message: structuredClone(message), receivedAt: Date.now() });
          return;
        }
        case "permission_request":
          this.permissions.push({ ...(event as AcpPermissionEvent) });
          return;
        case "elicitation_request":
          this.elicitations.push({ ...(event as AcpElicitationEvent) });
          return;
        default:
          return;
      }
    });
  }

  /** The folded tool calls in first-seen order (copies). */
  get toolCalls(): AcpAgentToolCall[] {
    return [...this.#toolCalls.values()].map((call) => ({ ...call }));
  }

  stop(): void {
    this.#active = false;
    this.#untap();
  }

  #foldToolCall(update: AcpSessionUpdate): void {
    if (update.sessionUpdate === "tool_call") {
      const existing = this.#toolCalls.get(update.toolCallId);
      const meta = record(update._meta);
      const entry: MutableToolCall = existing ?? { toolCallId: update.toolCallId, title: update.title, status: "pending" };
      entry.title = update.title;
      if (typeof update.name === "string") entry.name = update.name;
      if (update.kind !== undefined && update.kind !== null) entry.kind = update.kind;
      if (update.status !== undefined && update.status !== null) entry.status = update.status;
      if (update.rawInput !== undefined) entry.rawInput = update.rawInput;
      if (update.rawOutput !== undefined) entry.rawOutput = update.rawOutput;
      if (update.content !== undefined && update.content !== null) entry.content = update.content;
      if (update.locations !== undefined && update.locations !== null) entry.locations = update.locations;
      if (meta) entry.meta = { ...(entry.meta ?? {}), ...meta };
      if (!existing) this.#toolCalls.set(update.toolCallId, entry);
      return;
    }
    if (update.sessionUpdate !== "tool_call_update") return;
    const existing = this.#toolCalls.get(update.toolCallId);
    const meta = record(update._meta);
    const entry: MutableToolCall = existing ?? {
      toolCallId: update.toolCallId,
      title: typeof update.title === "string" ? update.title : "",
      status: "pending",
    };
    if (typeof update.title === "string") entry.title = update.title;
    if (typeof update.name === "string") entry.name = update.name;
    if (update.kind !== undefined && update.kind !== null) entry.kind = update.kind;
    if (update.status !== undefined && update.status !== null) entry.status = update.status;
    if (update.rawInput !== undefined) entry.rawInput = update.rawInput;
    if (update.rawOutput !== undefined) entry.rawOutput = update.rawOutput;
    if (update.content !== undefined && update.content !== null) entry.content = update.content;
    if (update.locations !== undefined && update.locations !== null) entry.locations = update.locations;
    if (meta) entry.meta = { ...(entry.meta ?? {}), ...meta };
    if (!existing) this.#toolCalls.set(update.toolCallId, entry);
  }
}

/**
 * THIS turn's usage. `response.usage` is PER-TURN on every installed adapter (Claude, Codex and pi
 * all report the turn — `PROMPT_USAGE_SCOPES`), so it maps straight to `AgentUsage`; `cost` is the
 * clamped delta of the cumulative `usage_update` cost gauge across the turn (the one channel that
 * IS cumulative), and a response without `usage` falls back to the context-token gauge delta —
 * exactly `UsageAccumulator.delta()`'s two rules. Never a before/after subtraction of accumulator
 * snapshots (the accumulator REPLACES its prompt usage per turn, so that arithmetic would be garbage).
 */
export function turnUsageOf(
  response: PromptResponse,
  gaugeBefore: UsageBaseline,
  gaugeAfter: UsageBaseline,
): { turn: AgentUsage; response?: AcpAgentTurnUsage["response"] } {
  const cost = Math.max(0, gaugeAfter.costAmount - gaugeBefore.costAmount);
  const u = response.usage ?? undefined;
  if (u) {
    return {
      turn: {
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cacheRead: u.cachedReadTokens ?? 0,
        cacheWrite: u.cachedWriteTokens ?? 0,
        total: u.totalTokens ?? 0,
        cost,
      },
      response: u,
    };
  }
  return {
    turn: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: Math.max(0, gaugeAfter.contextUsedTokens - gaugeBefore.contextUsedTokens),
      cost,
    },
  };
}

/** Fold one turn into the agent's running session sum; `cost` is the latest cumulative gauge. */
export function addUsage(prev: AgentUsage, turn: AgentUsage, gaugeAfter: UsageBaseline): AgentUsage {
  return {
    input: prev.input + turn.input,
    output: prev.output + turn.output,
    cacheRead: prev.cacheRead + turn.cacheRead,
    cacheWrite: prev.cacheWrite + turn.cacheWrite,
    total: prev.total + turn.total,
    cost: gaugeAfter.costAmount,
  };
}

export interface BuildTurnArgs {
  readonly response: PromptResponse;
  readonly collector: TurnCollector;
  readonly handle: TurnHandle;
  readonly backend: Backend;
  /** The schema active for THIS turn (per-turn override or the session schema), if any. */
  readonly schema: TSchema | undefined;
  /** The injected StructuredOutput capture taken for this turn, if any (`takeCaptured()`). */
  readonly captured: unknown;
  /** The agent's running session sum BEFORE this turn. */
  readonly sessionBefore: AgentUsage;
}

/** Assemble the turn: verbatim response, folded text, the turn's history slice (copies), usage
 *  per the per-turn model above (with the session sum AFTER this turn), and the structured result. */
export function buildTurn(args: BuildTurnArgs): AcpAgentTurn {
  const { response, collector, handle, backend, schema, captured, sessionBefore } = args;
  const gaugeAfter = handle.usage.baseline();
  const usage = turnUsageOf(response, collector.gaugeBefore, gaugeAfter);
  const historyStart = Math.min(collector.historyStart, handle.history.length);
  const history = handle.history.slice(historyStart).map((entry) => ({ ...entry }));
  const structured = schema ? resolveTurnStructured({ schema, handle, backend, captured }) : {};
  return {
    response,
    stopReason: response.stopReason,
    text: handle.foldedTurnText(),
    updates: collector.updates,
    raw: collector.raw,
    toolCalls: collector.toolCalls,
    permissions: collector.permissions,
    elicitations: collector.elicitations,
    usage: {
      turn: usage.turn,
      session: addUsage(sessionBefore, usage.turn, gaugeAfter),
      ...(usage.response !== undefined ? { response: usage.response } : {}),
    },
    ...(structured.structured !== undefined ? { structured: structured.structured } : {}),
    ...(structured.structuredError !== undefined ? { structuredError: structured.structuredError } : {}),
    history,
  };
}
