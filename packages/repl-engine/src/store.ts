/**
 * The results-by-call-id call store — the broker's append-only settlement
 * ledger (the roadmap doc's transfer lesson 1: "results recorded by call
 * ID before being settled into the guest"). This is the ONLY host-side
 * state that must survive independently of snapshots: on restore, the
 * snapshot's guest registry is read back and each outstanding call is
 * reconciled — a call the store shows as completed settles from here,
 * exactly once.
 *
 * Two implementations, mirroring the harness reference broker's store
 * (`agentprism-rust/crates/broker/src/store.rs`):
 *
 * - `InMemoryCallStore` — volatile (tests, ephemeral hosts).
 * - `JsonlCallStore` — a durable append-only JSON-lines file. Every
 *   mutation is one appended line, written and fsynced synchronously
 *   (dispatch handlers run inside a VM eval and cannot await); reopening
 *   replays the log and repairs a crash-torn final line instead of
 *   refusing the file (the doc's kill-at-any-point posture: torn tails
 *   are the normal lifecycle, not a recovery path — the harness's ledger
 *   IDs R55/R81).
 *
 * First-wins everywhere, mirroring the guest registry's settlement
 * idempotence: `recordDispatched` keeps the original record for a known
 * id, `recordCompleted` keeps the FIRST completion and reports whether
 * THIS call newly recorded one. That is what makes the broker's
 * record→settle→consume delivery loop safely retryable: a crash between
 * the store write and the guest settlement leaves both sides idempotent,
 * so the next delivery attempt settles the call exactly once.
 *
 * One workspace instance per file: no locking, no compaction. Forks of
 * one snapshot mint overlapping call ids, so a multi-workspace host gives
 * each workspace its own store file (the daemon's per-project `repl/`
 * directory, a later phase's wiring).
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';

/** Which guest call produced a record. */
export type CallKind = 'agent' | 'checkpoint' | 'steer';

/** How a completed call settled. */
export type CallOutcomeKind = 'resolve' | 'reject';

/**
 * The settlement of a completed call: the outcome plus the JSON-safe
 * value it settled with (the resolution value, the `{ name, message,
 * code?, recoverable? }` rejection object, the steering outcome string,
 * or the parsed checkpoint answer).
 */
export interface CallOutcome {
  outcome: CallOutcomeKind;
  value: unknown;
  completedAtMs: number;
}

/** One call's full record. */
export interface CallRecord {
  /** The stable guest-facing call id (`"c1"`, `"c2"`, …). */
  callId: string;
  kind: CallKind;
  /** Verbatim prompt (agent), question (checkpoint), or action (steer). */
  detail: string;
  /** Verbatim `optionsJson` string, or null. */
  optionsJson: string | null;
  /**
   * The agent call's backend-routing spec, VERBATIM including the guest's
   * reserved `"default"` sentinel (agent calls only; null otherwise) —
   * the phase-D review round-2 fix: backend identity/pool routing is
   * persisted with the dispatch, so a restore (or a lazy re-attach of a
   * settled handle) never routes by the CURRENT configured default and
   * misses a still-resumable original session. `null` on legacy records
   * (pre-attachment logs).
   */
  modelSpec: string | null;
  /**
   * The RESOLVED backend id the call's session opened under (agent calls
   * whose session opened; recorded by `recordAttached` alongside the
   * session id, overwritten by a re-issue's new session). The re-attach
   * routing pin: `loadSession` routes by this id (a backend id doubles as
   * a model routing spec) instead of re-resolving the model spec against
   * the current default backend. `null` for checkpoint/steer records,
   * agent records whose session never opened, and legacy logs.
   */
  backendId: string | null;
  dispatchedAtMs: number;
  /** Times this call was re-issued after being found lost (same call id). */
  reissues: number;
  /** Present once the call completed (first completion wins). */
  completion: CallOutcome | null;
  /** The FOUNDING session id for steer records (the session being steered
   *  — the restore path's queue rebuild keys on it); for AGENT records, the
   *  backend ACP session id the call's session opened under (`recordAttached`
   *  — the restore path's re-attach key), overwritten by a re-issue's new
   *  session. Null for checkpoint records, for steer records is the founding
   *  id, and for agent records whose session never opened (or whose record
   *  predates the attachment log). */
  sessionId: string | null;
  /** Queued-for-next-turn delivery state (steer records whose completion
   *  is the `queued` outcome): the unix-ms moment the queued payload was
   *  handed to the session as a delivery turn, or null while the steer
   *  still awaits delivery. A `delivered` marker is the point of no
   *  return: a restored broker must never re-deliver a marked steer
   *  (replay without duplication). */
  deliveredAtMs: number | null;
  /** The unix-ms moment a §4.2 followUp/steer was QUEUED for a delivery
   *  turn (cap pressure on an idle session, the answer semantics — its
   *  promise stays pending until the delivery runs, so it carries NO
   *  completion). The durable counterpart of the delivery-outcome
   *  completion: the restore's queue rebuild re-queues these exactly
   *  once (see `recordQueued`); null otherwise. */
  queuedAtMs: number | null;
  /** The unix-ms moment a queued steer's delivery was DROPPED (the
   *  founding call was cancelled, its delivery turn was cancelled, or
   *  the founding session never opened) — the durable counterpart of
   *  the in-memory queue drop, so a restore never resurrects a dropped
   *  delivery. Null while undropped. At most one of `deliveredAtMs` /
   *  `droppedAtMs` is ever set. */
  droppedAtMs: number | null;
}

/**
 * The store seam. All operations are synchronous: dispatch handlers run
 * inside a VM eval (a host callback cannot await), and the settlement
 * pump records before settling — so the write must be durable before the
 * function returns.
 */
export interface CallStore {
  /** Idempotent per call id: a known id keeps its original record. */
  recordDispatched(record: CallRecord): void;
  /** Record that a lost call was re-issued under the same id. Throws for
   *  an id the store has never seen (a dangling re-issue would corrupt
   *  the replay ledger). */
  recordReissued(callId: string, atMs: number): void;
  /**
   * Record the backend ACP session id an agent call's session opened
   * under — the restore path's re-attach key (`sessionId` on the record) —
   * plus the RESOLVED backend id that session belongs to (`backendId`, the
   * re-attach routing pin: a restore or lazy re-attach routes by it
   * instead of re-resolving the model spec against the current default
   * backend). OVERWRITES: the record carries the CURRENT session — a
   * re-issued call's new session replaces the lost one (the log keeps the
   * history as appended lines, and replay applies them in order). Throws
   * for an id the store has never seen dispatched.
   */
  recordAttached(callId: string, sessionId: string, atMs: number, backendId?: string | null): void;
  /**
   * Record a completion. Returns `true` iff the completion was newly
   * recorded; `false` when the call already had one (first-wins, no
   * change). Throws for an id the store has never seen dispatched.
   */
  recordCompleted(callId: string, outcome: CallOutcome): boolean;
  /**
   * Record a queued steer's delivery state (first-wins per state; a
   * second `delivered`/`dropped` record for the same call is a no-op).
   * Throws for an id the store has never seen dispatched.
   */
  recordDelivery(callId: string, state: 'delivered' | 'dropped', atMs: number): void;
  /**
   * Record that a §4.2 followUp/steer was QUEUED for a delivery turn
   * (the answer semantics — its completion is deliberately NOT
   * recorded here: the promise resolves with the turn's answer when
   * the delivery runs, and the store's first completion is the
   * settlement authority). First-wins; the restore's queue rebuild
   * keys on this marker. Throws for an id the store has never seen
   * dispatched.
   */
  recordQueued(callId: string, atMs: number): void;
  lookup(callId: string): CallRecord | undefined;
  /** Every record, in first-dispatch order. */
  all(): CallRecord[];
}

function unknownCall(callId: string): Error {
  return new Error(`call store: no record for call ${callId}`);
}

// ────────────────────────────────────────────────────────────────────────
// In-memory
// ────────────────────────────────────────────────────────────────────────

/** Volatile store: a Map plus dispatch order. */
export class InMemoryCallStore implements CallStore {
  private readonly records = new Map<string, CallRecord>();
  private readonly order: string[] = [];

  recordDispatched(record: CallRecord): void {
    if (this.records.has(record.callId)) return; // idempotent — keep the original
    this.order.push(record.callId);
    // Normalize legacy records (pre-delivery-marker logs) onto the current shape.
    this.records.set(record.callId, {
      ...record,
      sessionId: record.sessionId ?? null,
      modelSpec: record.modelSpec ?? null,
      backendId: record.backendId ?? null,
      deliveredAtMs: record.deliveredAtMs ?? null,
      droppedAtMs: record.droppedAtMs ?? null,
      queuedAtMs: record.queuedAtMs ?? null,
    });
  }

  recordReissued(callId: string, atMs: number): void {
    const record = this.records.get(callId);
    if (record === undefined) throw unknownCall(callId);
    record.reissues += 1;
    record.dispatchedAtMs = atMs;
  }

  recordAttached(callId: string, sessionId: string, atMs: number, backendId?: string | null): void {
    const record = this.records.get(callId);
    if (record === undefined) throw unknownCall(callId);
    record.sessionId = sessionId;
    record.backendId = backendId ?? null;
    void atMs;
  }

  recordCompleted(callId: string, outcome: CallOutcome): boolean {
    const record = this.records.get(callId);
    if (record === undefined) throw unknownCall(callId);
    if (record.completion !== null) return false; // first completion wins
    record.completion = outcome;
    return true;
  }

  recordDelivery(callId: string, state: 'delivered' | 'dropped', atMs: number): void {
    const record = this.records.get(callId);
    if (record === undefined) throw unknownCall(callId);
    if (state === 'delivered') {
      if (record.deliveredAtMs !== null) return; // first-wins
      record.deliveredAtMs = atMs;
      return;
    }
    if (record.droppedAtMs !== null) return; // first-wins
    record.droppedAtMs = atMs;
  }

  recordQueued(callId: string, atMs: number): void {
    const record = this.records.get(callId);
    if (record === undefined) throw unknownCall(callId);
    if (record.queuedAtMs !== null) return; // first-wins
    record.queuedAtMs = atMs;
  }

  lookup(callId: string): CallRecord | undefined {
    return this.records.get(callId);
  }

  all(): CallRecord[] {
    return this.order.map((id) => this.records.get(id)!).filter((r) => r !== undefined);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Durable JSON-lines store
// ────────────────────────────────────────────────────────────────────────

/** One appended line in the JSONL log. */
type LogLine =
  | { event: 'dispatched'; record: CallRecord }
  | { event: 'reissued'; callId: string; atMs: number }
  | { event: 'attached'; callId: string; sessionId: string; atMs: number; backendId?: string | null }
  | { event: 'completed'; callId: string; outcome: CallOutcome }
  | { event: 'delivery'; callId: string; state: 'delivered' | 'dropped'; atMs: number }
  | { event: 'queued'; callId: string; atMs: number };

function isLogLine(value: unknown): value is LogLine {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { event?: unknown };
  if (v.event === 'dispatched') {
    const r = (value as { record?: unknown }).record;
    return (
      typeof r === 'object' &&
      r !== null &&
      typeof (r as CallRecord).callId === 'string' &&
      typeof (r as CallRecord).detail === 'string' &&
      ((r as CallRecord).optionsJson === null || typeof (r as CallRecord).optionsJson === 'string') &&
      typeof (r as CallRecord).dispatchedAtMs === 'number' &&
      typeof (r as CallRecord).reissues === 'number' &&
      ((r as CallRecord).completion === null || typeof (r as CallRecord).completion === 'object')
    );
  }
  if (v.event === 'reissued') {
    return (
      typeof (value as { callId?: unknown }).callId === 'string' &&
      typeof (value as { atMs?: unknown }).atMs === 'number'
    );
  }
  if (v.event === 'attached') {
    const a = value as { callId?: unknown; sessionId?: unknown; atMs?: unknown; backendId?: unknown };
    return (
      typeof a.callId === 'string' &&
      typeof a.sessionId === 'string' &&
      typeof a.atMs === 'number' &&
      (a.backendId === undefined || a.backendId === null || typeof a.backendId === 'string')
    );
  }
  if (v.event === 'completed') {
    const o = (value as { outcome?: unknown }).outcome;
    return (
      typeof o === 'object' &&
      o !== null &&
      ((o as CallOutcome).outcome === 'resolve' || (o as CallOutcome).outcome === 'reject') &&
      typeof (o as CallOutcome).completedAtMs === 'number'
    );
  }
  if (v.event === 'delivery') {
    const d = value as { callId?: unknown; state?: unknown; atMs?: unknown };
    return (
      typeof d.callId === 'string' &&
      (d.state === 'delivered' || d.state === 'dropped') &&
      typeof d.atMs === 'number'
    );
  }
  if (v.event === 'queued') {
    const q = value as { callId?: unknown; atMs?: unknown };
    return typeof q.callId === 'string' && typeof q.atMs === 'number';
  }
  return false;
}

/**
 * Durable store: an append-only JSON-lines file. Every mutation is one
 * line, written and fsynced on write; opening replays the log into an
 * in-memory index — repairing a crash-torn final line first (below).
 *
 * ## Torn tails are repaired; mid-log corruption is refused
 *
 * Every append is `<json>\n` written in one call, so a process killed
 * mid-append leaves exactly one artifact shape: a FINAL line with no
 * terminating newline. That artifact must not make the session
 * unopenable (kill-at-any-point is the normal lifecycle), so:
 *
 * - **Unterminated + unparseable** — only a crash mid-append produces
 *   this shape; the fragment's bytes are durably preserved in a
 *   `<file>.torn-<unix ms>` sidecar next to the log, then the file is
 *   truncated to the last `\n` boundary. Truncating restores the file to
 *   "all complete records", so the NEXT append can never fuse onto the
 *   fragment and compound the damage.
 * - **Unterminated + parseable** — the crash landed between a record's
 *   bytes and its newline; the record is complete, so it is KEPT and the
 *   missing terminator is written back. Truncating here would vaporize a
 *   real record (e.g. a completion whose result was already paid for).
 * - **Terminated but unparseable, anywhere** — a line that HAS its
 *   newline was fully written, which is past the append discipline's only
 *   crash window; garbage there means external damage, and silently
 *   skipping records from the middle of the audit log would corrupt
 *   everything replayed after it. That stays a hard error.
 *
 * The repair runs in BYTE space before any UTF-8 decoding: a torn tail
 * can split a multi-byte character (`detail` is verbatim prompt text),
 * and decoding the whole file first would fail on the invalid tail and
 * take every intact record with it. The sidecar is written and synced
 * BEFORE the truncation, so a failure to preserve leaves the log
 * untouched for the next attempt.
 *
 * ## Appends heal to the acknowledged prefix
 *
 * The store tracks `cleanLen`: the byte offset of the durably
 * ACKNOWLEDGED prefix — every byte at or below it belongs to a record
 * whose append fully succeeded. A failed `writeSync` can leave a partial
 * line behind, and a retried append after it would fuse into one
 * newline-terminated but unparseable line — turning a transient IO error
 * into what the next open must treat as permanent corruption. Every
 * append therefore starts from the acknowledged prefix: leftover partial
 * bytes are truncated away first, then the line is written.
 */
export class JsonlCallStore implements CallStore {
  private readonly filePath: string;
  private fd: number;
  /** Byte length of the durably acknowledged prefix (see module docs). */
  private cleanLen: number;
  private readonly index = new InMemoryCallStore();

  private constructor(path: string, fd: number, cleanLen: number) {
    this.filePath = path;
    this.fd = fd;
    this.cleanLen = cleanLen;
  }

  /** Open (or create) the log at `path` and replay it. */
  static open(path: string): JsonlCallStore {
    let raw: Buffer = Buffer.alloc(0);
    if (existsSync(path)) {
      raw = readFileSync(path);
    }
    // The complete region: everything up to and including the last
    // newline (the whole file when empty or newline-terminated).
    const boundary = raw.length === 0 || raw[raw.length - 1] === 0x0a ? raw.length : raw.lastIndexOf(0x0a) + 1;
    const index = new InMemoryCallStore();
    // Complete lines were written by JSON.stringify, so the region is
    // valid UTF-8 by construction; anything else there is genuine
    // corruption, refused loudly like any other.
    const complete = raw.subarray(0, boundary).toString('utf8');
    let lineNo = 0;
    for (const line of complete.split('\n')) {
      lineNo++;
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`call store ${path}:${lineNo}: corrupt log line (${(error as Error).message})`);
      }
      if (!isLogLine(parsed)) {
        throw new Error(`call store ${path}:${lineNo}: unrecognized log line`);
      }
      replay(index, parsed);
    }
    const tail = raw.subarray(boundary);
    let terminateTail = false;
    if (tail.length > 0) {
      let parsedTail: LogLine | undefined;
      try {
        const candidate: unknown = JSON.parse(tail.toString('utf8'));
        if (isLogLine(candidate)) parsedTail = candidate;
      } catch {
        parsedTail = undefined;
      }
      if (parsedTail !== undefined) {
        // A complete record missing only its `\n`: keep it, and terminate
        // it below so the next append starts its own line.
        replay(index, parsedTail);
        terminateTail = true;
      } else {
        // A crash artifact: preserve the fragment first (durably — the
        // truncation below destroys the only other copy), then truncate
        // to the last complete-record boundary.
        preserveTornFragment(path, tail);
        const fd = openSync(path, 'r+');
        try {
          ftruncateSync(fd, boundary);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    }
    const fd = openSync(path, 'a');
    if (terminateTail) {
      writeSync(fd, '\n');
      fsyncSync(fd);
    }
    // Everything on disk right now is complete, replayed records: the
    // acknowledged prefix is the whole file.
    const cleanLen = getSize(fd);
    const store = new JsonlCallStore(path, fd, cleanLen);
    // Transfer the replayed index (records are first-wins copies — the
    // replayed completions travel inside the dispatched records).
    for (const record of index.all()) {
      store.index.recordDispatched(record);
    }
    return store;
  }

  /** The log file's path. */
  path(): string {
    return this.filePath;
  }

  recordDispatched(record: CallRecord): void {
    if (this.index.lookup(record.callId) !== undefined) return; // idempotent
    this.append({ event: 'dispatched', record });
    this.index.recordDispatched(record);
  }

  recordReissued(callId: string, atMs: number): void {
    // Validate against the index first so the log never carries a
    // dangling re-issue.
    if (this.index.lookup(callId) === undefined) throw unknownCall(callId);
    this.append({ event: 'reissued', callId, atMs });
    this.index.recordReissued(callId, atMs);
  }

  recordAttached(callId: string, sessionId: string, atMs: number, backendId?: string | null): void {
    if (this.index.lookup(callId) === undefined) throw unknownCall(callId);
    this.append({ event: 'attached', callId, sessionId, atMs, backendId: backendId ?? null });
    this.index.recordAttached(callId, sessionId, atMs, backendId);
  }

  recordCompleted(callId: string, outcome: CallOutcome): boolean {
    const existing = this.index.lookup(callId);
    if (existing === undefined) throw unknownCall(callId);
    if (existing.completion !== null) return false; // first completion wins
    this.append({ event: 'completed', callId, outcome });
    return this.index.recordCompleted(callId, outcome);
  }

  recordDelivery(callId: string, state: 'delivered' | 'dropped', atMs: number): void {
    const existing = this.index.lookup(callId);
    if (existing === undefined) throw unknownCall(callId);
    const marker = state === 'delivered' ? existing.deliveredAtMs : existing.droppedAtMs;
    if (marker !== null) return; // first-wins per state
    this.append({ event: 'delivery', callId, state, atMs });
    this.index.recordDelivery(callId, state, atMs);
  }

  recordQueued(callId: string, atMs: number): void {
    const existing = this.index.lookup(callId);
    if (existing === undefined) throw unknownCall(callId);
    if (existing.queuedAtMs !== null) return; // first-wins
    this.append({ event: 'queued', callId, atMs });
    this.index.recordQueued(callId, atMs);
  }

  lookup(callId: string): CallRecord | undefined {
    return this.index.lookup(callId);
  }

  all(): CallRecord[] {
    return this.index.all();
  }

  /** Close the log file. Idempotent; the in-memory index stays readable. */
  close(): void {
    if (this.fd === -1) return;
    closeSync(this.fd);
    this.fd = -1;
  }

  /** True once `close()` ran (the log file is closed; any later write
   *  throws). The teardown-completeness probe (phase-D review round 8:
   *  a rejected disposal used to skip the store close — the daemon
   *  shutdown regression asserts the store really closed). */
  isClosed(): boolean {
    return this.fd === -1;
  }

  private append(line: LogLine): void {
    // Retry safety for the delivery loop (which retries a failed
    // completion write with the SAME outcome): a failed write can leave
    // a PARTIAL line behind, and a retry appended after it would fuse
    // both into one newline-terminated but unparseable line. Every
    // append therefore starts from the acknowledged prefix: heal any
    // leftover partial bytes first, then write; on failure, roll back
    // (best effort — the pre-write heal covers a failed rollback too).
    if (getSize(this.fd) !== this.cleanLen) {
      ftruncateSync(this.fd, this.cleanLen);
    }
    const buf = Buffer.from(`${JSON.stringify(line)}\n`, 'utf8');
    let written = 0;
    try {
      while (written < buf.length) {
        written += writeSync(this.fd, buf, written, buf.length - written);
      }
      fsyncSync(this.fd);
    } catch (error) {
      try {
        ftruncateSync(this.fd, this.cleanLen);
      } catch {
        // Best effort — the next append's pre-write heal covers it.
      }
      throw error;
    }
    this.cleanLen += buf.length;
  }
}

/** Apply one replayed log line to the in-memory index. */
function replay(index: InMemoryCallStore, line: LogLine): void {
  if (line.event === 'dispatched') index.recordDispatched(line.record);
  else if (line.event === 'reissued') index.recordReissued(line.callId, line.atMs);
  else if (line.event === 'attached') index.recordAttached(line.callId, line.sessionId, line.atMs, line.backendId ?? null);
  else if (line.event === 'completed') index.recordCompleted(line.callId, line.outcome);
  else if (line.event === 'queued') index.recordQueued(line.callId, line.atMs);
  else index.recordDelivery(line.callId, line.state, line.atMs);
}

/** Current file size of an open fd. */
function getSize(fd: number): number {
  return fstatSync(fd).size;
}

/**
 * Preserve a torn tail's bytes in a sidecar next to the log —
 * `<file>.torn-<unix ms>` — written and synced BEFORE the log is
 * truncated, so a failure here aborts the open with the log untouched:
 * the fragment is never vaporized. A sidecar FILE rather than a log
 * line, deliberately: the fragment is raw bytes and can end
 * mid-UTF-8-character, which a text log cannot carry faithfully.
 */
function preserveTornFragment(path: string, fragment: Buffer): string {
  const nowMs = Date.now();
  let attempt = 0;
  for (;;) {
    const suffix = attempt === 0 ? `${nowMs}` : `${nowMs}-${attempt}`;
    const candidate = `${path}.torn-${suffix}`;
    try {
      const fd = openSync(candidate, 'wx');
      try {
        writeSync(fd, fragment);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        attempt += 1;
        continue;
      }
      throw error;
    }
  }
}
