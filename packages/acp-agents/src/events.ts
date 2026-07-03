// Typed ACP event bus for AcpAgentRunner. Every ACP `session/update` a pooled connection receives
// is bubbled up here UNCHANGED (plus a small session-context envelope), so a caller can
// `runner.on("tool_call", evt => …)` and listen in on a live run WITHOUT touching the AgentRunner
// seam (which stays a pure prompt -> result function). The event NAMES are the ACP `sessionUpdate`
// discriminants verbatim (agent_message_chunk, tool_call, …) so the surface tracks the protocol
// 1:1; each payload is that exact ACP update variant intersected with AcpEventContext. A handful
// of non-update events (permission_pending/request, raw_message, session_open/close,
// backend_error) round out "everything the runner sees on the wire".
//
// Listeners are OBSERVERS and best-effort: a throwing listener is isolated and never breaks the
// run, the synchronous update drain, or sibling listeners — the same contract as onUsage/onHistory.
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { BackendId } from "./backend.js";

/** The ACP session/update discriminated union (every real-time update an agent can stream). */
export type AcpSessionUpdate = SessionNotification["update"];
/** The `sessionUpdate` discriminant strings (agent_message_chunk | tool_call | usage_update | …). */
export type AcpUpdateKind = AcpSessionUpdate["sessionUpdate"];

/** Which run / session / backend an event belongs to. A pooled runner multiplexes many concurrent
 *  sessions over one process, so every event carries this envelope for disambiguation/filtering. */
export interface AcpEventContext {
  /** ACP session id this event pertains to. */
  sessionId: string;
  /** Backend that produced it ("claude" | "codex"). */
  backendId: BackendId;
  /** `RunOptions.label` of the originating run(), if one was set. */
  label?: string;
  /** `RunOptions.runId` correlation id, if one was set. */
  runId?: string;
}

/** Per-discriminant events: key = ACP `sessionUpdate` string, payload = that variant + context. */
type AcpSessionUpdateEvents = {
  [K in AcpUpdateKind]: Extract<AcpSessionUpdate, { sessionUpdate: K }> & AcpEventContext;
};

/** A tool-permission request parked on an async resolver. This is the FIRST phase of the
 *  resolver path only: it fires after the request is tracked for teardown cancellation and before
 *  the host resolver is invoked. It carries no outcome because no ACP response has been returned
 *  yet. Synchronous ToolPolicy decisions never emit this event. */
export interface AcpPermissionPendingEvent extends AcpEventContext {
  request: RequestPermissionRequest;
}

/** A tool-permission request the runner answered, paired with the FINAL decision it returned.
 *  This is the SECOND phase for resolver-backed permissions and the ONLY phase for synchronous
 *  ToolPolicy permissions. It fires exactly once per request with the outcome sent to the agent. */
export interface AcpPermissionEvent extends AcpEventContext {
  request: RequestPermissionRequest;
  outcome: RequestPermissionResponse;
}

/** A vendor extension notification (e.g. Claude `_claude/sdkMessage`) routed to a session. */
export interface AcpRawMessageEvent extends AcpEventContext {
  method: string;
  message: unknown;
}

/** A pooled backend process crashed (not a graceful dispose). The engine retries the run on a
 *  fresh process; this surfaces the crash for observability. Carries no session context. */
export interface AcpBackendErrorEvent {
  backendId: BackendId;
  error: Error;
}

/**
 * The full typed event map for AcpAgentRunner — every ACP `session/update` kind, plus the
 * cross-cutting events. The keys are exactly the strings you pass to `runner.on(...)`, and the
 * value is the payload your listener receives.
 */
export type AcpRunnerEventMap = AcpSessionUpdateEvents & {
  /** Catch-all: fires for EVERY session/update regardless of kind (carries the raw update). */
  session_update: { update: AcpSessionUpdate } & AcpEventContext;
  /** A permission request parked on an async resolver; resolver path only, no outcome yet. */
  permission_pending: AcpPermissionPendingEvent;
  /** A permission request the runner answered, with the FINAL decision returned. */
  permission_request: AcpPermissionEvent;
  /** A vendor extension notification arrived for a session. */
  raw_message: AcpRawMessageEvent;
  /** A new session was opened on a pooled connection. */
  session_open: AcpEventContext;
  /** A session was released / closed. */
  session_close: AcpEventContext;
  /** A pooled backend process crashed (not a graceful dispose). */
  backend_error: AcpBackendErrorEvent;
};

export type AcpEventName = keyof AcpRunnerEventMap;
export type AcpEventListener<K extends AcpEventName> = (event: AcpRunnerEventMap[K]) => void;

/** Non-session/update runner events. Kept exact by the type-level guard below so a new
 *  cross-cutting event cannot be added to AcpRunnerEventMap without updating forwarders. */
export const ACP_CROSS_CUTTING_EVENT_NAMES = [
  "permission_pending",
  "permission_request",
  "raw_message",
  "session_open",
  "session_close",
  "backend_error",
] as const satisfies readonly AcpCrossCuttingEventName[];

type AcpCrossCuttingEventName = Exclude<AcpEventName, AcpUpdateKind | "session_update">;
type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type _AcpCrossCuttingEventNamesComplete = Assert<
  IsNever<Exclude<AcpCrossCuttingEventName, (typeof ACP_CROSS_CUTTING_EVENT_NAMES)[number]>>
>;
type _AcpCrossCuttingEventNamesExact = Assert<
  IsNever<Exclude<(typeof ACP_CROSS_CUTTING_EVENT_NAMES)[number], AcpCrossCuttingEventName>>
>;

/** Internal emit boundary handed from the runner down through the pool to each connection. */
export interface AcpEventSink {
  <K extends AcpEventName>(name: K, event: AcpRunnerEventMap[K]): void;
}

/**
 * A tiny strongly-typed event emitter (no node:events, zero deps). `on()`/`once()` return an
 * unsubscribe thunk. `emit()` ISOLATES listener exceptions — one bad listener can never break the
 * run, the synchronous drain, or sibling listeners — mirroring the best-effort contract of
 * onUsage/onHistory. Generic over any event map `{ name: payload }`.
 */
export class TypedEventEmitter<EventMap> {
  private readonly listeners = new Map<keyof EventMap, Set<(event: unknown) => void>>();

  /** Subscribe to `name`. Returns an unsubscribe thunk (calling it is equivalent to `off`). */
  on<K extends keyof EventMap>(name: K, listener: (event: EventMap[K]) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener as (event: unknown) => void);
    return () => this.off(name, listener);
  }

  /** Subscribe once: the listener auto-unsubscribes after its first delivery. */
  once<K extends keyof EventMap>(name: K, listener: (event: EventMap[K]) => void): () => void {
    const off = this.on(name, (event) => {
      off();
      listener(event);
    });
    return off;
  }

  off<K extends keyof EventMap>(name: K, listener: (event: EventMap[K]) => void): void {
    const set = this.listeners.get(name);
    if (!set) return;
    set.delete(listener as (event: unknown) => void);
    if (set.size === 0) this.listeners.delete(name);
  }

  removeAllListeners(name?: keyof EventMap): void {
    if (name === undefined) this.listeners.clear();
    else this.listeners.delete(name);
  }

  listenerCount(name: keyof EventMap): number {
    return this.listeners.get(name)?.size ?? 0;
  }

  emit<K extends keyof EventMap>(name: K, event: EventMap[K]): void {
    const set = this.listeners.get(name);
    if (!set || set.size === 0) return;
    // Snapshot so a listener that (un)subscribes during dispatch can't perturb this emit.
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // Listeners are observers — never let one break the run or sibling listeners.
      }
    }
  }
}

/**
 * Fan ONE ACP session/update out to the typed bus: the `session_update` catch-all first, then the
 * per-discriminant event. The payload IS the update variant merged with `ctx`, but TS cannot
 * correlate the runtime discriminant `name` with the mapped payload type at the call site, so the
 * (name, payload) pair is asserted once here against the precise indexed type — never `any`.
 */
export function emitSessionUpdate(emit: AcpEventSink, update: AcpSessionUpdate, ctx: AcpEventContext): void {
  emit("session_update", { update, ...ctx });
  const name = update.sessionUpdate;
  emit(name, { ...update, ...ctx } as AcpRunnerEventMap[typeof name]);
}
