# Live workflow observability

## Source

The design owner made the following statements. They are reproduced verbatim from
`.agentprism/design-observability/focus.md` §0 and are the authority for this contract.

> "all three of what they described as what they wanted - '#1 (emit mid-flight content/heartbeat events) is the load-bearing piece; #2 (subscribable resource) and #3 (incremental history)' need to go out, together. No descoping any of these." *(2026-07-20)*

> "I want to reiterate this so YOU DO NOT DESCOPE/LEAVE 'TODO'/FOLLOWUP WORK: ALL THREE OF THE FEEDBACK REQUESTS SHOULD BE IN SCOPE AND DELIVERED" *(2026-07-20)*

> "Same process as before - contract delivery WITH EVERYTHING IN SCOPE, then implementation and delivery trains. Use gpt sol xhigh kimi xhigh(pi) and 1 Fable xhigh." *(2026-07-20)*

> "kimi k3, just to be specific so you dont choose a worse model." *(2026-07-20)*

The tracking issue is [#261](https://github.com/VikashLoomba/agentprism-workflows/issues/261).
The customer-originated Requests block is reproduced in the normative focus file and fixes the
three product requirements used below:

- **R1 — progress:** persist a content-bearing signal while an agent call is in flight, not only
  when it settles. This is load-bearing, not permission to omit R2 or R3.
- **R2 — subscription:** expose the live per-run event stream at
  `workflow://runs/{runId}/events` and push `notifications/resources/updated` after appends.
- **R3 — history:** make the running agent's message/tool activity durable and readable
  incrementally as a live transcript rather than only after settlement.

The first two owner quotations are the product authority for every normative requirement. The
last two govern the author/review workflow and do not change the runtime API. Each normative
section declares its R1/R2/R3 trace so no one request can disappear during implementation.

## 1. Scope, outcome, and invariants

**Source trace:** owner quotations 1–2; R1, R2, R3.

This contract ships all three requests in one coordinated release. A conforming implementation
lets a supervising MCP client subscribe before or during a long run, receive a bounded
content-bearing `agentProgress` record before that call's `agentEnd`, catch up exactly from the
durable cursor after coalesced notifications, and reduce redacted `agentTranscript` upserts into a
readable transcript while the agent remains `running`.

The following invariants are normative:

1. **All three or none.** The release is not complete unless R1, R2, and R3 and their tests ship
   together. R2 over an unchanged lifecycle-only stream is not completion.
2. **Default-on.** No feature flag, script option, tool input, environment variable, backend
   allowlist, or client capability beyond the standard MCP resource-subscription capability turns
   this behavior on. Every journaling run uses it. The existing explicit `journaling: false`
   behavior still means no durable run artifact and therefore no durable events resource.
3. **Content-bearing progress.** Every persisted `agentProgress` contains at least one of
   `latestText` or `lastToolName`. Counts-only records are forbidden. Heartbeats repeat the most
   recently projected content; the implementation never invents text for a backend that has not
   produced any.
4. **Additive public formats.** Existing event record fields, event meanings, URI meanings, run
   JSON fields, hashes, model routing, and backend selection do not change. New fields and the new
   event members are additive. `RUN_EVENT_LOG_VERSION` remains numeric `1`.
5. **One root stream.** Nested engine scopes write to the root managed run's one event log. Every
   new record retains both root `runId` and originating `scope`; `(scope, callIndex)` is the call
   key.
6. **Safety before durability.** No raw assistant text, tool name/title, label, phase, or transcript
   string reaches JSONL or run JSON. It first passes the existing credential redactor and the
   existing 512-byte UTF-8 scalar bound. The existing 65,536-byte JSONL record guard remains the
   final check.
7. **Observation cannot control execution.** Projection, sampling timers, transcript upserts,
   event-resource watchers, MCP notification delivery, and subscriber behavior never
   await, pause, fail, retry, or cancel an agent call. Existing synchronous file persistence can
   consume local I/O time; no subscriber or transport promise is on that path.
8. **No event or transcript retention quota.** This contract adds no event-count, run-duration,
   transcript-entry-count, log-size, subscriber-count, or per-run byte quota. Safety bounds apply per
   scalar, per record, per MCP response, and to constant-space in-memory coalescing only. Run
   deletion retains its existing cleanup semantics.
9. **Backend symmetry.** The ACP projection switches on protocol update kinds, not provider IDs.
   Claude, Codex, OpenCode, pi, and custom ACP backends follow identical rules. Any third-party
   `AgentRunner` with no ACP event bus remains source-compatible, but no fake transcript/progress is
   produced when a runner exposes no live content source.
10. **Verbatim model resolution.** No model spec, mode, config option, effort/thinking value,
    backend choice, prompt, or call hash is normalized or altered by this feature.

## 2. Verified baseline at the pinned repository commit

**Source trace:** owner quotations 1–2; R1 establishes the missing signal, R2 the missing delivery
surface, and R3 the missing durable history.

The References section pins every statement in this section to base commit
`5456431e17e21b1873fa203fd684c1176c8513a3`.

1. `PersistedRunEvent` has twelve lifecycle/result members and no progress or transcript member.
   `PersistableEngineRunEvent` explicitly excludes `agentHistory`, while the JSONL validator's
   `EVENT_TYPES` set accepts only those twelve names [L1, L2].
2. JSONL records already carry version `1`, a 32-hex `streamId`, dense `seq`, timestamp, projected
   event, and redaction/truncation flags. `appendEvent` projects before append, rejects records over
   65,536 bytes, and `readEvents`/`watchEvents` expose durable cursor-based reads [L1, L2].
3. The complete ACP update firehose already reaches the SDK `WorkflowManager` as the live-only
   `agentEvent` event. It carries backend/session context and, when supplied by the engine, label,
   scope/run ID, and call index. The manager isolates throwing listeners from the run [L3, L4].
4. ACP session state mutates its in-memory history as text chunks and tool calls arrive, and emits
   the unchanged update after applying it [L5]. Contrary to the preliminary focus-file mechanism
   note, the pinned runner invokes `RunOptions.onHistory` only from its `finally` block after the
   attempt has settled; the engine manager therefore receives no mid-call history today [L6].
5. When `onAgentHistory` fires during runner settlement, the engine replaces the matching in-memory agent
   snapshot and publishes a live-only `agentHistory` event. That handler calls `progress()` but not
   `persistRun`; `persistedState()` includes whatever snapshot history exists only when another
   settlement/checkpoint save occurs [L7, L8].
6. `PersistedAgentState.history` is currently typed as `AgentHistoryEntry[]`. The safe `inspect`
   source type and outward call-status allowlist omit history entirely [L8, L9].
7. The MCP server registers and subscribes only `workflow://runs/{runId}/script`. It already
   advertises `{resources:{subscribe:true,listChanged:true}}` and handles standard
   Subscribe/Unsubscribe requests, but has no per-run events resource and sends no per-append
   resource update [L10, L11].
8. The event tail is already consumed server-side by `await`: `readEvents` establishes a cursor,
   `watchEvents` drains subsequent records, and terminal event types settle the wait. Its progress
   projection counts starts/ends and phase only, so it carries no current agent content [L12,
   L13].
9. Existing safety machinery redacts credential-shaped text and sensitive keys, truncates a scalar
   to 512 UTF-8 bytes, compacts structured values by depth/array/key bounds, and marks the record's
   projection. It is the only projector this contract extends [L14].

## 3. Public type and event-log contract

**Source trace:** owner quotations 1–2; R1 directly, R2 consumes this event, R3 is correlated by
the same call key.

### 3.1 Shared event types

Add the following shared types in `packages/shared-types/src/run-events.ts` and export them from
`@automatalabs/shared-types`, `@automatalabs/workflow-engine`, and the established
`@automatalabs/workflows` facade:

```ts
export interface RunAgentProgressPayload extends RunEventOrigin {
  label: string;
  phase?: string;
  callIndex: number;
  /** Completed assistant text segments observed for this logical call. The active
   * segment counts as one from its first text chunk. */
  turnCount: number;
  /** Recognized ACP activity items observed for this logical call, cumulative. */
  observedEvents: number;
  /** Recognized activity folded into this sample in addition to the triggering item. */
  coalescedEvents: number;
  cause: "activity" | "heartbeat";
  /** Most recent assistant segment preview. Raw on the live manager event; redacted
   * and <=512 UTF-8 bytes in PersistedRunEvent. */
  latestText?: string;
  /** Most recent tool kind, falling back to title. Raw live; projected when persisted. */
  lastToolName?: string;
  /** Latest non-negative safe-integer ACP usage_update.used value, when supplied. */
  tokensObserved?: number;
}

export type RunAgentProgressEvent =
  { type: "agentProgress" } & RunAgentProgressPayload;

export interface RunAgentTranscriptPayload extends RunEventOrigin {
  label: string;
  phase?: string;
  callIndex: number;
  /** Dense zero-based readable-entry index within this logical call. */
  entryIndex: number;
  /** Dense zero-based replacement revision within this entry. */
  revision: number;
  operation: "upsert";
  entry: AgentHistoryEntry;
}

export type RunAgentTranscriptEvent =
  { type: "agentTranscript" } & RunAgentTranscriptPayload;
```

Both new events are added to `EngineRunEvent`; unlike `agentHistory`, both are included in
`PersistableEngineRunEvent`. `PersistedRunEvent` gains both discriminants and their numeric fields,
with every string projected. `EngineRunEventName`, payload maps, manager overloads, SDK facade
exports, JSONL `EVENT_TYPES`, input validation, persisted validation, and exhaustiveness switches
must all acquire both members. Existing members are byte-for-byte unchanged.

All numeric fields must be non-negative safe integers. `callIndex`, `turnCount`, and
`observedEvents` are required. Exactly one own string field among `latestText` and `lastToolName`
is required and its trimmed value must remain non-empty after projection. A value that becomes
empty after redaction/truncation is omitted; if no content remains, that sample is not appended.
Unknown raw activity never becomes an `agentProgress` record.

For `agentTranscript`, `entryIndex` and `revision` must be non-negative safe integers,
`operation` must be exactly `"upsert"`, and `entry` must satisfy the existing
`AgentHistoryEntry` role/kind shape. New persisted transcript entries allow only assistant text and
tool calls: `{role:"assistant",kind:"text"}` or `{role:"tool",kind:"toolCall"}`. `text` must be
non-empty after projection and `timestamp` is required as a non-negative safe-integer epoch
millisecond. An assistant entry forbids `toolName` and `isError`; a tool entry requires non-empty
`toolName` and forbids `isError`. Each record's existing top-level `projection` flags disclose
redaction/truncation performed by the persistence projector on either persisted string. Selecting
the defined rolling assistant window or bounded progress tool-name preview is sampling, not a
projection truncation; transcript tool title/name still arrive raw and report projector truncation.

### 3.2 Attribution

The raw ACP envelope's `runId` names the engine scope. The workflows facade resolves the root run
by an active manager agent row matching `(scope = payload.runId, callIndex)`; it additionally
checks `label` when the envelope supplies one. The row exists because `onAgentStart` runs before
runner delegation. Zero or multiple matches are an unattributed observation: the raw public
`agentEvent` is still delivered unchanged, but it is not persisted and does not mark the event log
incomplete. Both new events copy `label`, optional `phase`, and `callIndex` from that sole active
row. Their root `runId` is the managed run ID and `scope` is the raw engine scope.

Retries share the logical `(scope, callIndex)` accumulator. A retry therefore keeps cumulative
turn/activity counts and most-recent content until the one logical `agentEnd`. A nested workflow
uses its nested scope and remains in the root log. Post-`agentEnd` or post-run-terminal raw traffic
is delivered on the existing live `agentEvent` bus but ignored by durable progress/transcript.

## 4. Shared firehose source and progress projection

**Source trace:** owner quotations 1–2; R1 directly; R2 receives its output; R3 shares the same
source and call attribution.

### 4.1 One reusable source

Move the existing ACP runner subscription logic from `packages/workflows/src/index.ts` into
`packages/workflows/src/agent-event-source.ts` and name the reusable surface
`WorkflowAgentEventSource`. It owns one subscription to the runner's `session_update` catch-all and
one to every exact `ACP_CROSS_CUTTING_EVENT_NAMES` member, unwraps the catch-all to the concrete
update discriminant exactly as today, and multicasts the unchanged `WorkflowAgentEventPayload` to
a set of isolated sinks.

The module exports:

```ts
export interface WorkflowAgentEventSink {
  observe(event: WorkflowAgentEventPayload): void;
}

export interface WorkflowAgentEventSource {
  attach(sink: WorkflowAgentEventSink): () => void;
}

export function workflowAgentEventSource(runner: AgentRunner): WorkflowAgentEventSource;
```

The factory returns the process-global `WeakMap` entry for that runner; the entry owns the one
underlying subscription set across managers. `attach` is ref-counted, returns an idempotent detach
function, subscribes on the zero-to-one transition, unsubscribes on one-to-zero, snapshots sinks
during dispatch, and catches each sink's exception. The source never
clones, persists, redacts, or samples the raw event. Existing `WorkflowManager`
construction/per-run attachment/disposal behavior and the public `agentEvent` listener types remain
source-compatible via re-exports from `packages/workflows/src/index.ts`.

The SDK manager attaches two isolated actions in order for each raw event: best-effort feed the
live-observability projector, then emit the existing raw `agentEvent` in a `finally` path so adapter
failure cannot suppress it. This named source is the common primitive the
separate evals trajectory sink can consume without reparsing or re-subscribing to ACP. This
contract implements only the live-observability sink.

The workflows package also exports the pure ACP adapter
`projectWorkflowAgentActivity(event): WorkflowAgentActivity | undefined`. The backend-neutral type
is exported by workflow-engine and has this frozen shape:

```ts
export interface WorkflowAgentActivityBase {
  scope: string;
  callIndex: number;
  label?: string;
}

export type WorkflowAgentActivity = WorkflowAgentActivityBase & (
  | { kind: "assistant-text"; text: string; messageId?: string }
  | { kind: "tool-call"; title: string; toolName: string }
  | { kind: "content-boundary" }
  | { kind: "usage"; tokensObserved?: number }
);
```

The SDK subclass calls the engine manager's protected, non-throwing
`observeAgentActivity(activity): void` before raw event delivery. The engine manager maintains a
map from JSON-encoded `[scope, callIndex]` to the set of active managed agent rows, populated at
`onAgentStart` and removed at `agentEnd`/root finalization. Exactly one matching owner admits an
activity. This index is bounded by active calls and avoids scanning all runs for every token.
The adapter returns `undefined` unless the envelope has a non-empty scope and non-negative safe
`callIndex`; malformed context never reaches that index.

### 4.2 Recognized activity and readable history

The provider-neutral projector recognizes these ACP update kinds:

| Update | Progress effect | Transcript effect |
| --- | --- | --- |
| text `agent_message_chunk` | start/extend current assistant segment; set `latestText` | append revision `0` on open; upsert each sampled content change |
| `tool_call` | end text segment; set `lastToolName` | flush the assistant, then append one tool-call upsert immediately |
| `user_message_chunk`, `agent_thought_chunk`, `tool_call_update`, `plan`, `plan_update`, `plan_removed` | end the current assistant segment; count activity | flush the assistant's newest changed revision |
| `usage_update` | retain valid `used` as `tokensObserved`; count activity | no transcript row |
| every other update/cross-cutting event | no sampled progress mutation | no transcript row |

The ACP adapter admits `agent_message_chunk` only when `content.type === "text"` and `text` is
non-empty. It copies a non-empty `messageId` when present. A change from one present `messageId` to
another closes the prior assistant segment; consecutive chunks with the same ID, or consecutive
chunks for which the ID is absent, extend it. A recognized content-boundary update also closes the
segment. `turnCount` increments exactly when the first text chunk opens a segment, never per token.

The active segment keeps a rolling raw UTF-8 suffix bounded to
`MAX_OBSERVABILITY_SCALAR_BYTES`; it does not retain an array of chunks or a whole message. On every
append, concatenate the suffix and new chunk and retain the newest complete Unicode scalars that
fit the bound. That bounded raw window is the live event's `latestText`; the persistence projector
applies `redactText` and `truncateUtf8(..., MAX_OBSERVABILITY_SCALAR_BYTES)` before disk. The
accumulator also computes that safe projection for change comparison without replacing the raw
window, so projection flags remain accurate when the event is persisted. Split credential-shaped
text that remains in the window is rechecked across chunk boundaries.
Text activity makes `latestText` the sole progress content field and clears `lastToolName`; tool
activity makes `lastToolName` the sole progress content field and clears `latestText`. Boundary and
usage activity retain the last content. A heartbeat therefore repeats exactly the latest projected
content kind rather than preferring an older tool over newer text.

For `tool_call`, the adapter requires non-empty `title` and reuses the existing
`toolNameFromMeta` lookup semantics: inspect `_meta` object values in insertion order and take the
first nested object's non-empty string `toolName`; otherwise take non-empty `kind`, then `title`
[L5]. It never copies `_meta`, raw input/output, content, locations, status, or tool-call ID. The
tool transcript entry uses `text = title` and that derived `toolName`.
The progress accumulator stores `lastToolName` through
`truncateUtf8(..., MAX_OBSERVABILITY_SCALAR_BYTES)`; the immediate transcript entry still reaches
the persistence projector as the raw scalar so its outer truncation flag is exact.

An assistant entry takes the next `entryIndex` when its first text arrives and starts at revision
`0`; each materially changed sampled preview increments `revision`. Its numeric millisecond
`timestamp` is captured with `Date.now()` at that first chunk and remains stable across revisions.
A tool call closes the text segment, takes the next entry index with revision `0`, captures its
observation timestamp, and appends immediately. Generated entries omit `isError`; assistant entries
omit `toolName`, while tool entries require it. Entry indexes are dense within one logical call and
continue across retries. Reducers key entries by
`(scope, callIndex, entryIndex)` and retain only the greatest revision; equal or decreasing
revisions in a log are corrupt.

The existing live-only `onAgentHistory` event and settlement-time run JSON history remain exactly
as they are. They are not the R3 persistence path, so this feature does not reinterpret or rewrite
the established terminal run-file field.

### 4.3 Sampling constants and algorithm

Export these engine constants and use no runtime override:

```ts
export const AGENT_PROGRESS_MIN_INTERVAL_MS = 1_000 as const;
export const AGENT_PROGRESS_HEARTBEAT_MS = 15_000 as const;
```

Per active call, retain only the latest accumulator plus `dirty`, `coalescedEvents`, one sample
timer, and one heartbeat timer. There is no array/queue of unpersisted raw events.

`observedEvents` increments once for each admitted text, tool, boundary, or usage activity.
Immediately before an activity sample, let `n` be the observations since the prior successful
activity sample, or since call start for the first sample; the emitted `coalescedEvents` is
`max(0, n - 1)`. Heartbeats emit numeric `0`. The counter resets only after a successful activity
sample. An increment that would exceed a safe integer is a projection failure under §8, not a
wrapped or saturated count.

1. Opening any assistant segment appends transcript revision `0` immediately. A changed message ID
   or recognized content boundary first flushes the prior segment's newest changed revision, then
   closes it. A tool call performs that flush, appends its own revision `0`, and only then updates
   progress. Thus rapid distinct turns remain readable without retaining a pending-entry queue.
2. The first activity in a call that yields `latestText` or `lastToolName` appends
   `agentProgress{cause:"activity"}` immediately. Thereafter, if at least 1,000 ms has elapsed since
   the last successful activity sample, the next dirty activity samples immediately. Otherwise it
   replaces the pending preview/tool/tokens and arms one timer for the remaining interval. At the
   boundary, one sample carries the latest state.
3. Each successful progress sample arms a 15,000 ms heartbeat. If no successful sample occurs before it
   fires and the call still runs, append `cause:"heartbeat"` with the last content and cumulative
   counts. No heartbeat is emitted before any content exists.
4. When an activity sample contains a changed assistant preview, append the next
   `agentTranscript` revision immediately before its matching `agentProgress`. If the bounded
   preview bytes did not change, do not append a redundant transcript revision.
5. All timers are `unref()`'d, cleared at call/run finalization, and guarded against stale callbacks.
   Timer callbacks catch all errors.

The sample interval is the persisted granularity decision: token fidelity stays on the existing
in-process raw bus; the durable stream carries a coarse, content-bearing supervision view plus a
reducible bounded transcript. Progress and transcript are distinct events so R1 consumers do not
need reducer state and R3 consumers do not infer turns from heartbeats.

### 4.4 Finalization and execution isolation

Immediately before a call's `agentEnd` append, the manager flushes the newest changed assistant
revision and one pending content-bearing activity sample, in that order, regardless of the 1,000 ms interval,
cancels both timers, and deletes the accumulator. Therefore no valid pending transcript/progress
state is silently ordered after `agentEnd`. If an engine path reaches a root terminal transition
without `agentEnd`, it performs the same flush/cancel/delete sequence for every remaining
accumulator before the terminal event.

`publishRunEvent` retains its append-before-live-delivery order. A progress or transcript append failure follows
the existing rule: latch `eventLogIncomplete`, best-effort persist the marker, deliver the live
event, and stop further JSONL appends for that generation. Projection or persistence failure never
propagates into the workflow promise. Raw listener/source failure is caught even earlier and cannot
set `eventLogIncomplete` because no persistable event was admitted.

## 5. Redaction, bounds, and durable record semantics

**Source trace:** owner quotations 1–2; R1 and R3 contain new persisted content; R2 exposes only
the already-projected records.

Extend `projectRunEventForPersistence` rather than adding a second redactor. It projects
`agentProgress` and `agentTranscript` as follows:

- `runId`, `scope`, `label`, `phase`, `latestText`, and `lastToolName` use the same internal
  `projectText` path as lifecycle fields;
- numeric fields and `cause` are copied only after the input validator accepts them;
- transcript `entry.text` and required tool-entry `entry.toolName` use `projectText`; role, kind,
  timestamp, index, revision, and operation are copied only after exact validation;
- top-level `projection.redacted` and `projection.truncated` aggregate every projected string;
- no session ID, prompt, raw ACP payload, tool arguments/output, permission response, elicitation
  response, thought text, plan body, `_meta`, filesystem location, or backend error is persisted;
- the complete serialized `RunEventLogRecord` remains limited to 65,536 bytes and terminates with
  one newline.

The JSONL sequence remains gap-free. Sampling discards raw observations **before** sequence
allocation; it does not reserve sequence numbers for them. Each successful transcript upsert and
progress sample consumes exactly one next `seq`. `readEvents` and `watchEvents` require no special
path and return both new members in order with lifecycle events.

The log has no total-size retention limit and is never rewritten/compacted by this feature. A
subscriber that falls behind recovers from JSONL with `(streamId, seq)`; it does not rely on a
process buffer.

## 6. Live transcript contract

**Source trace:** owner quotations 1–2; R3 directly; R1 shares the activity accumulator; R2 is the
resource that carries transcript upserts.

### 6.1 Chosen R3 mechanism

R3 is implemented as `agentTranscript` upserts in the same durable events resource, not by
incrementally rewriting `PersistedAgentState.history` and not by registering another URI. The
customer explicitly allowed a live transcript in place of incremental run JSON history. This
choice preserves the established terminal run-file field byte/meaning contract, avoids rewriting
an ever-growing run JSON on every streaming interval, reuses the one redaction/cursor/error path,
and gives the subscribing MCP client the transcript directly.

The ordinary run JSON and live-only `agentHistory` manager event keep their current settlement
semantics. `inspect` remains bounded and unchanged; a client that needs the in-flight transcript
reads the events resource it already subscribed to. R3 is not inferred from sampled progress:
transcript upserts have their own exact reducer contract.

### 6.2 Reducer and ordering

A client builds the current transcript with this deterministic algorithm:

1. Deduplicate retried pages by exact `(streamId, seq)` before reducing; an already-applied sequence
   with the same canonical record is a no-op, while a different record at that sequence is corrupt.
2. Partition `agentTranscript` records by `(scope, callIndex)`.
3. Within a call, key by `entryIndex`; accept only a revision greater than the retained revision and
   replace the retained entry. `entryIndex` and `revision` begin at zero and are dense as specified
   in §4.2.
4. Render retained entries in ascending `entryIndex`. A tool entry never receives a replacement;
   an assistant entry may receive one replacement per changed 1-second preview and one final flush.
5. `agentEnd` finalizes the call after all transcript revisions in the same JSONL sequence. A root
   terminal event finalizes any call that lacks `agentEnd` after the manager's forced flush.

An equal/decreasing or skipped revision for the same entry, a nonzero initial revision, a skipped entry index,
a transcript record after its call's `agentEnd`, or a transcript record without a preceding
`agentStart` is a `CORRUPT_LOG` read failure. Retries do not create a second call partition; their
entries continue the same dense index space.

Cross-record validation applies the same active-call envelope to `agentProgress`. Both new event
types must carry the matching start's label and phase. Activity progress has a strictly increasing
`observedEvents` and nondecreasing `turnCount`; a heartbeat exactly repeats the preceding progress
state except for `cause` and `coalescedEvents: 0`. Either event before start or after end, a tool
entry revision other than `0`, or a mismatch in these invariants is `CORRUPT_LOG`. Old logs with no
new event type pass unchanged.

The transcript has no entry-count or total-byte retention cap. Each revision is independently
redacted and scalar/record bounded. A long assistant segment is therefore a readable current-window
preview of the newest complete Unicode scalars, capped by the existing numeric 512-byte safety
bound, not an unbounded verbatim capture. Its prior sampled windows remain in the append-only log.

### 6.3 MCP progress convenience

The MCP progress message uses the newest safely projected progress sample: `"<label>: tool
<lastToolName>"` when a tool is latest, otherwise `"<label>: <latestText>"`. Background `await`
handles the persisted `agentProgress` record in its existing event-log reporter.

For a foreground invocation, the server installs a temporary manager `agentProgress` listener
before `startInBackground`, assigns the returned run ID immediately, filters the listener to that
ID, and removes it in the tool handler's `finally` block. The listener projects `label` and content
again with the existing MCP redaction/512-byte helper before calling the request's progress
reporter; it reads settled/total counts from the matching live snapshot. The existing snapshot
callback continues to report lifecycle/phase changes. A progress event observed synchronously
before run-ID assignment is held in one latest-event slot and either delivered after assignment if
it matches or discarded; there is no queue.

Both paths keep their existing request-correlated `notifications/progress` behavior; absent
progress tokens remain a no-op, and notification promises are never awaited. These messages are a
convenience only; transcript reconstruction always uses `agentTranscript` records.

## 7. MCP events resource and subscription

**Source trace:** owner quotations 1–2; R2 directly, R1 supplies the meaningful updated content,
and R3 is the `agentTranscript` member carried by this resource.

### 7.1 URI, listing, and document

Register a second resource template:

```text
workflow://runs/{runId}/events
```

Its MIME type is `application/json`. It is listed for the same 50 newest discoverable persisted
runs as the script resource only when `eventStreamId` and `eventSeq` are present. Direct reads are
not limited by that discovery list. Admission and deletion continue to send one resource-list
changed notification covering both templates.

The template registration name is `"workflow-run-events"`, title is `"Workflow run events"`, and
description is `"Append-only, redacted workflow run events with cursor-based catch-up."`. Each
listed resource uses name `` `${workflowName} events (${runId})` ``, description
`` `${status} · append-only run events · started ${startedAt}` ``, and the JSON MIME type.
Template completion offers the same eligible run IDs from that newest-50 discovery window.

Every successful read returns one text content containing compact `JSON.stringify(document)` with
this exact shape. The content `mimeType` is `application/json`; its `uri` is the canonical URI for
a canonical read and the normalized query URI with keys ordered `after`, `limit`, `streamId` for a
page read:

```ts
export interface WorkflowRunEventsResourceDocument {
  schemaVersion: 1;
  runId: string;
  streamId: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
  /** True exactly when status is neither pending nor running. A subsequent explicit resumed
   * event can make the same stream non-final again. */
  finalized: boolean;
  /** Greatest sequence excluded from this page. */
  after: number;
  /** Greatest returned seq, or `after` for an empty page. */
  cursor: number;
  /** Complete JSONL tail at the read snapshot. */
  endCursor: number;
  hasMore: boolean;
  events: RunEventLogRecord[];
}
```

The canonical URI is a tail view: take a stable `endCursor`, set
`after = max(0, endCursor - RUN_EVENT_READ_LIMIT_DEFAULT)`, and return through that cursor. This
shows the most recent numeric `100` records on first read without making old records
unrecoverable.

Exact catch-up uses readable, non-listable page URIs:

```text
workflow://runs/{runId}/events?after={seq}&limit={n}&streamId={streamId}
```

`after` defaults to `0` only on a query-form read, `limit` defaults to numeric `100` and accepts
`1..1000`, and `streamId` is required for query-form reads. Query key order is irrelevant; each
known key may occur once. Unknown/duplicate keys, fragments, credentials, ports, non-decimal
numbers, leading signs, unsafe integers, and noncanonical run paths are invalid. Clients paginate
while `hasMore`, then retain `cursor` for the next update. Thus the response cap is a paging safety
bound, not a retention cap.

The URI parser applies the existing tool run-ID grammar exactly: 1–128 characters matching
`^[a-z0-9]+-[a-z0-9]+$`. Percent-encoded path delimiters or run IDs, an empty path segment, trailing
slash, or any path other than the exact two-segment `/RUN_ID/events` form is noncanonical [L10].

For either form, load the persisted run status first and then take the event-log page; a run deleted
between those operations is `RUN_NOT_FOUND`. This order makes `finalized` conservative during a
concurrent terminal transition. `finalized` is exactly
`status !== "pending" && status !== "running"`. The canonical tail uses a first bounded read to
obtain its generation/end cursor and a second same-generation read after
`max(0, endCursor - 100)`; concurrent appends can make `hasMore` true and are recovered through the
ordinary page loop.

### 7.2 Subscribe/unsubscribe and push

Only the canonical, query-free events URI is subscribable. A successful subscribe validates the
run and current event generation with `readEvents`, adds the URI to protocol state, and starts one
`watchEvents` pump at the current `endCursor`. A duplicate subscribe is idempotent and creates no
second watcher. Unsubscribe is idempotent for a known/deleted/currently subscribed URI, removes the
URI, closes its pump, and returns `{}`. Query-form subscription is rejected.

For every record drained by the pump, mark that URI dirty and schedule

```ts
void mcp.server.sendResourceUpdated({ uri: workflowRunEventsUri(runId) })
```

The notification is sent only for a URI in the subscription set. The per-URI scheduler has exactly
two booleans, `dirty` and `inFlight`. At most one transport promise is in flight. Records observed
while it is in flight collapse into one further notification. Fulfillment and rejection clear
`inFlight`; rejection is swallowed; if `dirty` became true, one new attempt is scheduled in a
microtask. The event pump never awaits notification delivery.

There is no per-subscriber event buffer. `watchEvents` drains the durable log one record at a time;
the dirty bit can collapse hints but cannot lose records. A slow client reads page URIs from its
last cursor. If it ignored all hints, any subsequent hint still lets it catch up. An absent
subscriber allocates no subscription-side watcher, timer, queue, or notification work and cannot
affect the run.

The pump remains attached while the protocol subscription exists, including across a paused/failed
same-ID run that is explicitly resumed. `agentEnd` and each root terminal event are ordered after
the final pending progress/transcript flush. The resource's `finalized` bit reflects the current run
status; a `resumed` record changes it back to false without changing `streamId`. Unsubscribe,
connection close, or run deletion closes all associated watchers and pending scheduler state. Run
deletion also removes the subscription and sends list-changed; it does not send a final
resource-updated notification for a resource that can no longer be read.

### 7.3 Existing surfaces

Script resource URI/read/subscription/lineage behavior remains unchanged. `await` continues to use
the same event log and terminal detection, but its progress reporter adds the `agentProgress`
content message from §6.3. Tool input/output schemas gain no field. Run/tool results and existing
script resource links remain compatible; documentation adds the events URI rather than replacing
script links.

## 8. Error and failure contract

**Source trace:** owner quotations 1–2; R1/R3 append failures must not fail execution and R2 errors
must be wire-stable.

The MCP dependency pins JSON-RPC `InvalidParams` to numeric **-32602** and `InternalError` to
numeric **-32603** [U1]. Those exact wire codes are required:

| Operation/failure | Result |
| --- | --- |
| read/subscribe malformed events URI or query; unknown run; known run without an event generation; query subscription | `McpError(ErrorCode.InvalidParams, safeMessage)`, code **-32602** |
| query `after`/`limit`/`streamId` invalid; cursor ahead; stream generation mismatch | code **-32602** |
| subscribe valid canonical URI | empty result `{}`; watcher is live before response |
| unsubscribe valid known/deleted/subscribed canonical URI | empty result `{}` |
| unsubscribe malformed or never-known URI | code **-32602** |
| event log `EVENT_LOG_INCOMPLETE`, `CORRUPT_LOG`, `UNSUPPORTED_VERSION`, `SNAPSHOT_AHEAD`, `RECORD_TOO_LARGE`, `PROJECTION_ERROR`, `SEQUENCE_MISMATCH`, or `IO_ERROR` during resource read/start | `McpError(ErrorCode.InternalError, safeMessage)`, code **-32603** |
| watcher hits one of those integrity/I/O errors after subscribe | mark URI dirty once so the client re-read receives **-32603**, close that watcher, retain protocol subscription; no automatic polling loop |
| `sendResourceUpdated` rejects or transport closes | swallow; clear bounded scheduler state; workflow and JSONL unchanged |
| raw event unattributed/malformed/unsupported | omit durable progress/transcript mutation; raw live event still forwarded; workflow and JSONL completeness unchanged |
| progress/transcript projection or append fails | existing `eventLogIncomplete` latch; raw live event still delivered; workflow result unchanged |
| timer callback races finalization | observe finalized state and no-op |

`safeMessage` includes the requested URI/run ID and the stable `RunEventLogError.code` when
available. It never includes filesystem paths, raw record bytes, content previews, stack/cause,
session IDs, or credentials. Protocol validation errors are request errors, not tool results and
not `isError` tool content.

The complete engine-to-wire mapping is frozen. `RUN_NOT_FOUND`, `ORPHANED_LOG`,
`EVENT_LOG_UNAVAILABLE`, `WATERMARK_MISSING`, `STREAM_ID_MISSING`, `INVALID_CURSOR`,
`INVALID_LIMIT`, `INVALID_STREAM_ID`, `STREAM_MISMATCH`, and `CURSOR_AHEAD` map to **-32602**.
`EVENT_LOG_INCOMPLETE`, `CORRUPT_LOG`, `UNSUPPORTED_VERSION`, `SNAPSHOT_AHEAD`,
`RECORD_TOO_LARGE`, `PROJECTION_ERROR`, `SEQUENCE_MISMATCH`, and `IO_ERROR` map to **-32603**.
No `RunEventLogError.code` falls through to an unpinned default.

An event log marked incomplete is not served partially. R1 and R3 share that integrity boundary: a
failed progress or transcript append makes the resource fail explicitly rather than presenting an
apparently complete transcript with a silent gap.

## 9. Compatibility, packaging, and release

**Source trace:** owner quotations 1–2; all R1/R2/R3 ship in one release without changing authored
workflow behavior.

- Run JSON and the live-only/settlement-time `agentHistory` field/event retain their exact existing
  meaning and serialization.
- Old JSONL without `agentProgress` is unchanged and readable. New JSONL uses version `1`; all old
  event shapes and their serialization stay unchanged. Consumers with exhaustive event switches
  must accept the additive members before reading new logs.
- The new events resource has its own `schemaVersion: 1`; incompatible document semantics require a
  different media-type version and schema version, not reinterpretation.
- No event enters call hashes, input hashes, resume matching, budget accounting, result values,
  agent retry policy, isolation serving, or model/backend resolution.
- Custom `RunPersistence` continues through `withRunEvents`. Custom runners remain source
  compatible because the `AgentRunner.run` shape and `RunOptions` fields do not change.

One coordinated changeset set ships:

| Package | Change | Bump |
| --- | --- | --- |
| `@automatalabs/shared-types` | additive progress/transcript resource-facing event types | minor |
| `@automatalabs/workflow-engine` | accumulator, projection, sampling, transcript ordering, JSONL validation | minor |
| `@automatalabs/workflows` | shared `WorkflowAgentEventSource`, ACP projection, facade re-exports | minor |
| `@automatalabs/mcp-server` | events resource, watcher/coalescer, content-bearing foreground/await progress | minor |
| `@automatalabs/acp-agents` | no runtime/type change; its existing firehose is consumed | none |

The changesets explicitly call out: default-on progress/transcript for journaling runs; additive
`agentProgress`/`agentTranscript`; transcript text is redacted and per-scalar bounded on disk; the new resource
and paging contract; notification coalescing; integrity-error mapping; and old-reader exhaustive
switch impact.

## 10. Documentation and generated artifacts

**Source trace:** owner quotations 1–2; R1/R2/R3 must be usable by an implementer/client that never
saw the feedback.

The implementation updates all of these in the same train:

- `docs/api.md`: event schemas, sampling/finalization, transcript reduction, canonical and paging
  URIs, cursor loop, notification advisory semantics, and the exact error matrix.
- root README plus `packages/workflows/README.md` and `packages/mcp-server/README.md`: one concise
  subscribe/read/catch-up example and link to the API contract.
- `skills/agentprism-workflow-authoring/SKILL.md` and `reference.md`: explain that long-running
  journaling workflows are observable without author annotations, how clients use run ID/events,
  and that progress is coarse while transcript upserts are reducible and cursor-backed.
- MCP authoring prompt: both edited skill files are inputs to
  `scripts/generate-authoring-prompt.mjs`; run that generator and commit
  `packages/mcp-server/src/generated/authoring-prompt-content.ts`. The existing drift test must
  pass; hand editing the generated file is forbidden [L16].
- tracking issue #261: implementation PR text closes it and names all three delivered requests.

## 11. Non-goals

**Source trace:** owner quotations 1–2. None of R1, R2, or R3 appears here.

- Persisting raw token-by-token ACP traffic, thoughts, plans, tool arguments/results, permission or
  elicitation payloads. Rationale: the supervision contract needs safe coarse content and readable
  message/tool history, while these fields multiply volume and secret exposure.
- Implementing the evals trajectory sink's scoring/storage layer. Rationale: this contract ships
  the shared `WorkflowAgentEventSource` it can consume, but scoring is a separate product surface.
- Changing total run-event retention, deletion policy, or adding a log compactor. Rationale: exact
  durable cursor catch-up works with the current append-only sidecar and this contract adds no
  retention quota.
- Making resource subscriptions a reliable message queue. Rationale: MCP update notifications are
  advisory; reliability comes from persisted `streamId`/`seq` paging.
- Exposing unredacted transcript content over MCP or JSONL. Rationale: run storage may already contain
  sensitive script/args/results, but every newly incremental content surface is safe by contract.
- Adding workflow-author controls over sample/heartbeat intervals. Rationale: behavior is
  default-on and consistent across runs/backends.

## 12. Considered and rejected alternatives

**Source trace:** owner quotations 1–2; decisions preserve all R1/R2/R3.

1. **Only make the existing lifecycle log subscribable.** Rejected because the stream remains
   silent between `agentStart` and `agentEnd`; this is the exact false fix prohibited by the owner.
2. **Persist every ACP token/update.** Rejected because token-level volume is unnecessary for
   supervision and amplifies secret/record-size risk. The chosen 1-second latest-state sample plus
   15-second content-bearing heartbeat preserves a useful signal, while the raw bus stays exact in
   process.
3. **Counts-only heartbeat from `agentStart`.** Rejected because it can look healthy without
   proving any model/tool content. Heartbeats start only after text/tool content and repeat it.
4. **A separate live-transcript URI.** Rejected because it creates two cursor/lifecycle/error
   authorities. `agentTranscript` upserts ride the same events resource and notification.
5. **Incrementally rewrite `PersistedAgentState.history`.** Rejected because it rewrites an
   ever-growing run JSON at streaming frequency, changes the established terminal field's safety
   semantics, and still requires a separate MCP delivery path. Transcript events are additive and
   already reach the subscriber.
6. **Rolling/capped persisted transcript.** Rejected because it would satisfy only a recent-view
   approximation of R3 and introduce a new retention quota. All projected upserts persist; paging
   and per-scalar/per-record safety bounds control response and record size.
7. **One `resources/updated` promise per event.** Rejected because a slow transport creates an
   unbounded promise/transport queue. One in-flight promise plus a dirty bit preserves hints and
   makes JSONL the backlog.
8. **Stateful per-client event cursor inside the server.** Rejected because reconnect/process
   restart would lose it and multiple reads could consume each other's state. Cursor state stays in
   resource documents and the client; reads are idempotent.
9. **Use `notifications/progress` as R2.** Rejected because it exists only when a specific tool
   request supplied a progress token and cannot supervise an independently running background run.
   It is enriched as a convenience, not used as the durable subscription surface.
10. **Fail the workflow when observability persistence fails.** Rejected because supervision must
   not control the work being supervised. Integrity failures are explicit to readers and existing
   incomplete markers/diagnostics are retained.
11. **Put ACP types in workflow-engine.** Rejected because it breaks the backend-neutral runner
    seam. The workflows facade owns ACP decoding; the engine consumes normalized activity.

## 13. Test plan

**Source trace:** owner quotations 1–2; every test group covers R1, R2, R3 or a shared safety and
compatibility invariant. All stated cases are release blockers.

### 13.1 Shared types and event persistence

- Type fixtures cover `agentProgress`, `agentTranscript`, their required numeric/content fields,
  reducer keys, and old event-union object literals.
- Existing JSONL fixtures remain byte-identical. New fixtures pin version `1`, exact projected
  progress JSON, dense sequence, top-level redacted/truncated flags, Unicode-safe 512-byte values,
  and 65,536-byte record rejection.
- Input/persisted validators reject negative/non-safe counts, empty content, both progress content
  fields absent, forbidden transcript roles/kinds, invalid entry/revision/operation, raw session/tool
  payload fields, invalid cause, malformed origin, and unknown event type.
- Projection fixtures cover secrets in one chunk and split across chunks, sensitive tool names,
  multibyte truncation, empty-after-projection omission, and a maximum-size valid record.
- `readEvents` and `watchEvents` return progress/transcript in exact order and retain cursor/stream
  behavior. Cross-record validation rejects skipped/decreasing revisions/indexes, tool revision,
  label/phase mismatch, non-monotonic progress, changed heartbeat state, and pre-start/post-end
  progress or transcript; all existing log error fixtures pass unchanged.

### 13.2 Shared firehose and manager progress (R1)

- One runner shared across managers/overlapping runs gets one source subscription and exact
  per-sink delivery; detach/dispose/ref-count/throwing-sink tests prove isolation and cleanup.
- Every ACP update discriminant is covered by an exhaustive type guard. Provider IDs are varied to
  prove identical behavior. Cross-cutting events remain raw-only.
- A controlled in-flight agent emits text, remains unresolved, and the test reads a persisted
  `agentProgress` containing `{callIndex,label,turnCount,latestText}` **before** resolving the
  runner and before any `agentEnd`. This is the load-bearing acceptance test.
- Tool-first activity persists `lastToolName` before settlement. Usage updates add valid
  `tokensObserved`; invalid values are ignored. Counts-only pre-content heartbeat never appears.
- Same/different/absent ACP message IDs, non-text content, tool/content boundaries, retries, nested
  scopes, same-label concurrency, and unattributed/ambiguous/post-terminal events follow §§3–4
  exactly. Tool-name precedence covers nested `_meta` tool names, kind, title, and empty candidates.
- Fake timers pin immediate first sample/upsert, one activity sample per 1,000 ms, latest-state
  replacement, changed-preview-only revisions, `coalescedEvents`, 15,000 ms heartbeat, dirty flush
  before `agentEnd`, terminal cleanup, `unref`, and stale callback no-op.
- A high-volume burst (at least 100,000 text chunks) produces constant-size pending state, no raw
  queue, bounded persisted sample count, correct final preview/counts, and no workflow latency tied
  to a fake slow subscriber.
- Append/projection/source-listener failures do not reject or alter the agent result; append failure
  sets `eventLogIncomplete` and subsequent JSONL reads fail as today.

### 13.3 Live transcript (R3)

- While the controlled agent promise is unresolved, JSONL contains revision `0` of an assistant
  entry and a tool-call entry; neither assertion resolves the runner or observes `agentEnd`.
- Consecutive same-message chunks retain one entry index and increasing revisions; message-ID
  changes and tool/content boundaries split segments; tool calls take the next index. Retries,
  stable first-observation timestamps, exact allowed keys/roles/kinds, and forced final revisions
  are pinned.
- A reducer fed one record at a time and one fed arbitrary resource pages produce the identical
  transcript. Duplicate page reads are idempotent at the client reducer while duplicate/decreasing
  revisions inside the log are corrupt.
- Secret and oversized transcript text/tool names never appear raw in JSONL or resource content.
  Top-level projection flags are exact for text-only, tool-only, and both-field changes.
- A long text-only turn exposes a changed current-window preview before settlement; a segment whose
  bounded preview no longer changes creates no redundant upsert but still produces heartbeats.
- Existing terminal run JSON history and live-only `agentHistory` fixtures remain byte-for-byte and
  behaviorally unchanged. A runner without an ACP event bus gets no fabricated transcript.

### 13.4 MCP resource and subscription (R2 plus R1 content)

- Resource list/template/direct-read tests cover discovery eligibility, the existing newest-50
  discovery rule, exact registration/list metadata and completion, canonical/query content URI
  normalization, MIME/compact JSON/schema version, status/finalized derivation, empty logs,
  latest-100 tail, concurrent canonical appends, and direct reads outside discovery.
- Query parser table covers every accepted default/bound and every forbidden duplicate, unknown,
  fragment, authority, numeric, stream, cursor, and path form. Paging 2,501 records with limit
  1,000 yields all records exactly once.
- Subscribe starts one watcher before `{}`; duplicate subscribe is idempotent; query subscribe and
  unknown/unavailable runs return numeric -32602. Unsubscribe/deletion/connection-close release
  watchers and timers.
- Append mid-flight `agentTranscript` and `agentProgress` records and assert a subscribed client
  receives `notifications/resources/updated`, reads the resource, and sees readable content before
  `agentEnd`.
- The **subscriber-falls-behind acceptance test** holds the first notification promise unresolved,
  appends more than one page, proves only one promise plus `dirty` exists, releases it, receives at
  most one subsequent hint, then pages from its old cursor with no gaps or duplicates.
- Notification rejection, connection close, absent subscriber, watcher integrity error, external
  process append, coalesced filesystem changes, paused/resumed same stream, final flush ordering,
  and run deletion follow §7.
- Exact numeric error assertions pin -32602/-32603 for every §8 row and verify safe messages omit
  paths/content/causes.
- Script-resource tests pass unchanged. Foreground and `await` progress tests now assert the safe
  content message; the foreground test covers a synchronous pre-run-ID event slot, run filtering,
  listener cleanup, and no queue. No-progress-token remains a no-op.

### 13.5 Compatibility, docs, and release

- Full package typecheck/build/test suites pass; existing journal hash, model-routing, resume,
  isolation, auth, cancellation, event-persistence, script-resource, and authoring-prompt drift
  suites remain green.
- Export-surface tests pin old import paths and the new constants/types/source helper from public
  package roots.
- Old run/event fixtures load without rewrite. Default journaling needs no new option and creates
  the resource whether or not the run ever emits progress; explicit `journaling: false` creates no
  durable resource. Tool/script/environment schemas contain no observability switch.
- Golden call/input hashes, raw authored model/config/mode values, backend routing, results,
  budgets, retries, and resume matching are identical with the observer present or absent. A custom
  `RunPersistence` wrapped by `withRunEvents` receives the new records through its existing seam.
- Docs snippets execute against an in-memory MCP transport and demonstrate subscribe, notification,
  canonical read, cursor catch-up, and transcript reduction.
- Changeset presence/content and generated-authoring-prompt drift are tested.

## 14. Implementation-time re-verification gate

**Source trace:** owner quotations 1–2; drift in either ACP content events or MCP subscription
semantics could invalidate R1 or R2.

Before editing implementation code, the implementer must perform a new freshness check. A cached
checkout, this author-round clone, or an npm cache answer is not sufficient. Run the equivalent of:

```bash
upstream_dir="$(mktemp -d)"
git clone https://github.com/modelcontextprotocol/typescript-sdk.git "$upstream_dir/mcp-sdk"
git clone https://github.com/agentclientprotocol/typescript-sdk.git "$upstream_dir/acp-sdk"
npm view @modelcontextprotocol/sdk dist-tags --json
npm view @agentclientprotocol/sdk dist-tags --json
git -C "$upstream_dir/mcp-sdk" fetch origin main --tags
git -C "$upstream_dir/acp-sdk" fetch origin main --tags
```

The implementer then verifies the exact cited symbols/files at the returned current `latest`
versions and diffs each release pin against `origin/main` for the cited surfaces. They also verify
every local [L*] citation against the implementation base. If an npm latest version, release tag,
commit, event discriminant, resource subscription/notification method, numeric error code, or local
mechanism differs from this contract, they must **stop before building and report the drift** with
the new pin and affected claim. Silent adaptation is forbidden; the spec owner decides whether the
contract needs amendment.

Author-round verification on 2026-07-20 found:

- `@modelcontextprotocol/sdk` npm `latest` = `1.29.0`, tag `v1.29.0`, commit
  `e12cbd7078db388152f6e839abdbe09ba01f3f32`.
- `@agentclientprotocol/sdk` npm `latest` = `1.2.1`, tag `v1.2.1`, commit
  `26da1ae7ab66fae0f5e77272dee3e5d562d24aee`.

The repository lock resolves those same versions [L15].

**Forward-compatibility risks found by diffing each pin to upstream main.** MCP upstream main was
`f4137630c05dc9a4fb14d4d3777f5cb167bd6313`; it contains an unreleased-for-this-package major
reorganization and a 2026-07-28 protocol path where generic subscription filters replace the
legacy `resources/subscribe` request, while retaining legacy-era compatibility surfaces. Adoption
of that package family requires re-verifying handler registration and notification routing; this
contract targets the current stable package. ACP upstream main was
`26cdeb48dc389335830fdb51d61dbfa88d644e96`; it adds an experimental major-revision API and changes
router implementation files, while the stable generated `SessionUpdate` union cited here remains
unchanged and the experimental union retains the text/tool/usage discriminants. Adoption of that
API requires re-verifying the envelope type and source adapter. These are risk notes, not permission
to omit any work in this contract.

## 15. Implementation sequence

**Source trace:** owner quotations 1–2; the sequence reaches one atomic R1/R2/R3 release.

1. Add shared progress/transcript types, projectors, validators, constants, and public re-exports with
   byte/error fixtures.
2. Extract `WorkflowAgentEventSource`, add provider-neutral activity normalization, and integrate
   manager attribution/accumulators with sampling and failure isolation.
3. Add projected transcript upserts, reducer validation, final ordering, and terminal-history
   compatibility fixtures.
4. Add the MCP event document/parser/template, subscription watcher/coalescer, exact error mapping,
   and content-bearing foreground/await progress.
5. Complete cross-package integration/backpressure tests, documentation, generated artifacts, and
   coordinated changesets. Publish only after all five stages are green together.

## 16. References

All local file/line citations were verified at base commit
`5456431e17e21b1873fa203fd684c1176c8513a3` on 2026-07-20. Line numbers refer to that exact tree.

- **[L1] Persisted/live event unions and JSONL envelope:**
  `packages/shared-types/src/run-events.ts:18-68`, `:139-188`, `:301-329`.
- **[L2] Event name allowlist, errors, projection-before-append, byte guard, read/watch:**
  `packages/workflow-engine/src/run-event-persistence.ts:22-42`, `:56-140`, `:530-630`,
  `:652-713`, `:832-922`, `:924-1072`.
- **[L3] SDK manager raw ACP envelope and bridge:**
  `packages/workflows/src/index.ts:422-459`, `:485-502`, `:569-643`.
- **[L4] Listener isolation and non-persistable history policy:**
  `packages/workflow-engine/src/workflow-manager.ts:493-499`, `:535-594`, `:1525-1565`.
- **[L5] Mid-stream session accumulator and emit-after-apply:**
  `packages/acp-agents/src/acp-client.ts:196-312`, `:709-715`, `:956-965`;
  `packages/acp-agents/src/events.ts:1-46`, `:157-225`.
- **[L6] Current history callback occurs in runner finalization:**
  `packages/acp-agents/src/runner.ts:1030-1052`;
  `packages/shared-types/src/agent-run.ts:137-153`.
- **[L7] Engine-to-manager history callback and manager mutation:**
  `packages/workflow-engine/src/workflow.ts:1470-1525`;
  `packages/workflow-engine/src/workflow-manager.ts:1789-1867`.
- **[L8] Persisted history field and snapshot-save path:**
  `packages/workflow-engine/src/run-persistence.ts:44-72`, `:132-223`;
  `packages/workflow-engine/src/workflow-manager.ts:2331-2435`.
- **[L9] Inspect omits history and applies bounded output:**
  `packages/workflow-engine/src/run-observability.ts:26-58`, `:204-234`, `:389-420`;
  `packages/shared-types/src/workflow-result.ts:518-567`, `:579-596`.
- **[L10] Existing run-ID grammar, script resource, subscriptions, and deletion cleanup:**
  `packages/mcp-server/src/workflow-tool-input.ts:103-108`;
  `packages/mcp-server/src/workflow-resources.ts:18-32`, `:45-80`, `:152-233`.
- **[L11] MCP resources capability registration:**
  `packages/mcp-server/src/server.ts:1149-1163`.
- **[L12] Await's durable event tail and terminal detection:**
  `packages/mcp-server/src/server.ts:960-1086`.
- **[L13] Existing count/phase-only progress projection:**
  `packages/mcp-server/src/progress.ts:1-26`, `:60-118`;
  `packages/mcp-server/src/server.ts:1527-1536`.
- **[L14] Existing redaction, scalar/structured bounds, and event projector:**
  `packages/workflow-engine/src/run-observability.ts:26-32`, `:71-92`, `:103-200`,
  `:500-516`, `:700-883`.
- **[L15] Local dependency declarations and exact lock resolutions:**
  `packages/mcp-server/package.json:50-54`; `packages/acp-agents/package.json:44-51`;
  `pnpm-lock.yaml:27-49`, `:80-100`, `:149-152`, `:664-669`.
- **[L16] Authoring prompt source inputs, generator, and byte-for-byte drift test:**
  `scripts/generate-authoring-prompt.mjs:13-46`, `:158-168`;
  `packages/mcp-server/test/authoring-prompt.test.ts:1-18`.

External sources were verified from fresh clones created during this author round, at the current
npm `latest` release pins above:

- **[I1] Scope issue:** [GitHub issue #261](https://github.com/VikashLoomba/agentprism-workflows/issues/261),
  whose customer-originated Requests block is reproduced verbatim in the normative focus file.
- **[U1] MCP stable resource subscription, update notification, sender, client methods, and numeric
  errors:** `modelcontextprotocol/typescript-sdk` tag `v1.29.0`, commit
  `e12cbd7078db388152f6e839abdbe09ba01f3f32`:
  `src/types.ts:191-205`, `:1030-1064`; `src/server/index.ts:322-335`, `:649-660`;
  `src/client/index.ts:708-725`.
- **[U2] ACP stable real-time session update and content/tool/usage discriminants:**
  `agentclientprotocol/typescript-sdk` tag `v1.2.1`, commit
  `26da1ae7ab66fae0f5e77272dee3e5d562d24aee`:
  `src/schema/types.gen.ts:281-296`, `:334-342`, `:3664-3770`, `:3772-3825`,
  `:4250-4276`;
  `src/acp.ts:1691-1718`, `:2658-2675`.
