import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  writeSync,
  type FSWatcher,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PersistableEngineRunEvent, RunEventLogRecord } from "@automatalabs/shared-types";
import {
  RUN_EVENT_MAX_RECORD_BYTES,
  RUN_EVENT_READ_LIMIT_DEFAULT,
  RUN_EVENT_READ_LIMIT_MAX,
  RunEventLogError,
  withRunEvents,
  type RunEventPersistence,
} from "../src/run-event-persistence.js";
import {
  createRunPersistence,
  type FsLayer,
  type PersistedRunState,
  type RunPersistence,
} from "../src/run-persistence.js";

const STREAM_A = "a".repeat(32);
const STREAM_B = "b".repeat(32);
const TIMESTAMP = "2026-01-02T03:04:05.000Z";

function state(runId: string, overrides: Partial<PersistedRunState> = {}): PersistedRunState {
  return {
    runId,
    workflowName: "event-persistence",
    script: "export const meta = { name: 'events', description: 'events' }",
    status: "running",
    phases: [],
    agents: [],
    logs: [],
    startedAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    eventStreamId: STREAM_A,
    eventSeq: 0,
    ...overrides,
  };
}

function stopped(runId: string): PersistableEngineRunEvent {
  return { type: "stopped", runId, scope: runId };
}

function expectCode(action: () => unknown, code: RunEventLogError["code"]): RunEventLogError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunEventLogError);
    assert.equal(error.name, "RunEventLogError");
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

function withPersistence(
  fn: (context: {
    persistence: RunEventPersistence;
    cwd: string;
    root: string;
    eventPath: (runId: string) => string;
  }) => void | Promise<void>,
  fsOverride?: Partial<FsLayer>,
) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ap-run-events-cwd-"));
    const root = mkdtempSync(join(tmpdir(), "ap-run-events-root-"));
    const persistence = createRunPersistence(cwd, fsOverride, { persistenceRoot: root });
    try {
      await fn({
        persistence,
        cwd,
        root,
        eventPath: (runId) => join(persistence.getRunsDir(), `${runId}.events.jsonl`),
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("event constants and RunEventLogError expose the frozen public contract", () => {
  assert.equal(RUN_EVENT_MAX_RECORD_BYTES, 65_536);
  assert.equal(RUN_EVENT_READ_LIMIT_DEFAULT, 100);
  assert.equal(RUN_EVENT_READ_LIMIT_MAX, 1_000);
  const cause = new Error("disk");
  const error = new RunEventLogError("failed", "IO_ERROR", {
    runId: "raw-run-id",
    seq: 7,
    path: "/absolute/run.events.jsonl",
    cause,
  });
  assert.equal(error.runId, "raw-run-id");
  assert.equal(error.seq, 7);
  assert.equal(error.path, "/absolute/run.events.jsonl");
  assert.equal(error.cause, cause);
});

test(
  "appendEvent writes one canonical line and readEvents provides stable cursors over a log-ahead snapshot",
  withPersistence(({ persistence, eventPath }) => {
    const runId = "append-read";
    persistence.save(state(runId));
    const first = persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) });
    const second = persistence.appendEvent(runId, {
      seq: 2,
      timestamp: TIMESTAMP,
      event: { type: "log", runId, scope: runId, message: "Bearer secret-token-value-01234567890123456789" },
    });

    assert.equal(first.streamId, STREAM_A);
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    const bytes = readFileSync(eventPath(runId));
    assert.equal(bytes.at(-1), 0x0a);
    assert.equal(bytes.toString("utf8").split("\n").length, 3);
    assert.equal(bytes.includes(Buffer.from("secret-token-value")), false);

    const page = persistence.readEvents(runId, { after: 0, limit: 1 });
    assert.deepEqual(page.events.map((record) => record.seq), [1]);
    assert.equal(page.streamId, STREAM_A);
    assert.equal(page.cursor, 1);
    assert.equal(page.endCursor, 2);
    assert.equal(page.hasMore, true);
    const continuation = persistence.readEvents(runId, { after: page.cursor, streamId: page.streamId });
    assert.deepEqual(continuation.events.map((record) => record.seq), [2]);
    assert.equal(continuation.cursor, 2);
    assert.equal(continuation.endCursor, 2);
    assert.equal(continuation.hasMore, false);
  }),
);

test(
  "read validation uses the exact option and snapshot classification precedence",
  withPersistence(({ persistence, eventPath }) => {
    expectCode(() => persistence.readEvents("missing", { after: -1, limit: 0, streamId: "bad" }), "INVALID_CURSOR");
    expectCode(() => persistence.readEvents("missing", { after: 0, limit: 0, streamId: "bad" }), "INVALID_LIMIT");
    expectCode(() => persistence.readEvents("missing", { after: 0, limit: 1, streamId: "bad" }), "INVALID_STREAM_ID");
    expectCode(() => persistence.readEvents("missing"), "RUN_NOT_FOUND");

    mkdirSync(persistence.getRunsDir(), { recursive: true });
    writeFileSync(eventPath("orphan"), "partial");
    const orphan = expectCode(() => persistence.readEvents("orphan"), "ORPHANED_LOG");
    assert.equal(orphan.path, eventPath("orphan"));

    persistence.save(state("legacy", { eventStreamId: undefined, eventSeq: undefined }));
    expectCode(() => persistence.readEvents("legacy"), "EVENT_LOG_UNAVAILABLE");
    writeFileSync(eventPath("legacy"), "partial");
    expectCode(() => persistence.readEvents("legacy"), "WATERMARK_MISSING");

    persistence.save(state("stream-missing", { eventStreamId: undefined, eventSeq: 0 }));
    expectCode(() => persistence.readEvents("stream-missing"), "STREAM_ID_MISSING");

    persistence.save(state("incomplete", { eventLogIncomplete: true }));
    expectCode(
      () => persistence.readEvents("incomplete", { streamId: STREAM_B }),
      "STREAM_MISMATCH",
    );
    expectCode(() => persistence.readEvents("incomplete"), "EVENT_LOG_INCOMPLETE");

    persistence.save(state("empty"));
    assert.deepEqual(persistence.readEvents("empty"), {
      events: [],
      streamId: STREAM_A,
      cursor: 0,
      endCursor: 0,
      hasMore: false,
    });
    expectCode(() => persistence.readEvents("empty", { after: 1 }), "CURSOR_AHEAD");
  }),
);

test(
  "terminated corrupt, oversized, unknown-version, sequence, generation, and watermark failures are never ignored",
  withPersistence(({ persistence, eventPath }) => {
    const cases = [
      { runId: "corrupt", bytes: "not-json\n", code: "CORRUPT_LOG" as const },
      { runId: "oversized", bytes: `${"x".repeat(RUN_EVENT_MAX_RECORD_BYTES)}\n`, code: "RECORD_TOO_LARGE" as const },
    ];
    for (const fixture of cases) {
      persistence.save(state(fixture.runId));
      writeFileSync(eventPath(fixture.runId), fixture.bytes);
      expectCode(() => persistence.readEvents(fixture.runId), fixture.code);
    }

    const runId = "record-validation";
    persistence.save(state(runId));
    const valid = persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) });

    writeFileSync(eventPath(runId), `${JSON.stringify({ ...valid, version: 2 })}\n`);
    expectCode(() => persistence.readEvents(runId), "UNSUPPORTED_VERSION");

    writeFileSync(eventPath(runId), `${JSON.stringify({ ...valid, event: { ...valid.event, scope: 4 } })}\n`);
    expectCode(() => persistence.readEvents(runId), "CORRUPT_LOG");

    writeFileSync(eventPath(runId), `${JSON.stringify({ ...valid, seq: 2 })}\n`);
    expectCode(() => persistence.readEvents(runId), "CORRUPT_LOG");

    writeFileSync(eventPath(runId), `${JSON.stringify({ ...valid, streamId: STREAM_B })}\n`);
    expectCode(() => persistence.readEvents(runId), "STREAM_MISMATCH");

    const additive = { ...valid, futureTopLevel: "retained", event: { ...valid.event, futureEventField: 9 } };
    writeFileSync(eventPath(runId), `${JSON.stringify(additive)}\n`);
    const additiveRead = persistence.readEvents(runId).events[0] as RunEventLogRecord & {
      futureTopLevel: string;
      event: RunEventLogRecord["event"] & { futureEventField: number };
    };
    assert.equal(additiveRead.futureTopLevel, "retained");
    assert.equal(additiveRead.event.futureEventField, 9);

    writeFileSync(eventPath(runId), `${JSON.stringify(valid)}\n`);
    persistence.save(state(runId, { eventSeq: 2 }));
    expectCode(() => persistence.readEvents(runId), "SNAPSHOT_AHEAD");
  }),
);

test(
  "an unterminated suffix is ignored by readers and repaired before the next lease epoch reuses its sequence",
  withPersistence(({ persistence, eventPath }) => {
    const runId = "tail-repair";
    persistence.save(state(runId));
    persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) });
    persistence.save(state(runId, { eventSeq: 1 }));
    persistence.releaseRunLease({ runId, token: "test-epoch" });

    const partial = Buffer.from('{"version":1,"seq":2', "utf8");
    const descriptor = openSync(eventPath(runId), "a");
    writeSync(descriptor, partial);
    closeSync(descriptor);
    const before = persistence.readEvents(runId, { after: 1 });
    assert.equal(before.endCursor, 1);
    assert.deepEqual(before.events, []);

    const second = persistence.appendEvent(runId, { seq: 2, timestamp: TIMESTAMP, event: stopped(runId) });
    assert.equal(second.seq, 2);
    const records = readFileSync(eventPath(runId), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as RunEventLogRecord);
    assert.deepEqual(records.map((record) => record.seq), [1, 2]);
  }),
);

test(
  "append validates candidates, wraps projection and filesystem failures, and detects short writes",
  withPersistence(({ persistence, eventPath }) => {
    const runId = "append-errors";
    persistence.save(state(runId));
    expectCode(
      () => persistence.appendEvent(runId, { seq: 2, timestamp: TIMESTAMP, event: stopped(runId) }),
      "SEQUENCE_MISMATCH",
    );
    expectCode(
      () => persistence.appendEvent(runId, { seq: 1, timestamp: "not-a-timestamp", event: stopped(runId) }),
      "CORRUPT_LOG",
    );
    expectCode(
      () => persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped("different") }),
      "CORRUPT_LOG",
    );
    expectCode(
      () => persistence.appendEvent(runId, {
        seq: 1,
        timestamp: TIMESTAMP,
        event: { type: "agentHistory", runId, scope: runId, label: "x", history: [], callIndex: 0 } as never,
      }),
      "CORRUPT_LOG",
    );

    const throwingResult = {};
    Object.defineProperty(throwingResult, "value", {
      enumerable: true,
      get() {
        throw new Error("projector exploded");
      },
    });
    const projection = expectCode(
      () => persistence.appendEvent(runId, {
        seq: 1,
        timestamp: TIMESTAMP,
        event: { type: "agentEnd", runId, scope: runId, label: "x", result: throwingResult, callIndex: 0 },
      }),
      "PROJECTION_ERROR",
    );
    assert.ok(projection.cause instanceof Error);
    assert.equal(projection.path, eventPath(runId));

    const escaped = "\0".repeat(512);
    const configOptions = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`${"\0".repeat(510)}${index.toString().padStart(2, "0")}`, escaped]),
    );
    expectCode(
      () => persistence.appendEvent(runId, {
        seq: 1,
        timestamp: TIMESTAMP,
        event: { type: "agentStart", runId, scope: runId, label: "x", prompt: "x", configOptions, callIndex: 0 },
      }),
      "RECORD_TOO_LARGE",
    );
  }),
);

test(
  "the writer performs one verified write and leaves sequence state unchanged after a short write",
  async () => {
    let writes = 0;
    let closes = 0;
    const cwd = mkdtempSync(join(tmpdir(), "ap-run-events-short-cwd-"));
    const root = mkdtempSync(join(tmpdir(), "ap-run-events-short-root-"));
    const persistence = createRunPersistence(
      cwd,
      {
        writeSync: ((...args: Parameters<typeof writeSync>) => {
          writes++;
          const buffer = args[1] as Uint8Array;
          return buffer.byteLength - 1;
        }) as typeof writeSync,
        closeSync: ((fd: number) => {
          closes++;
          closeSync(fd);
        }) as typeof closeSync,
      },
      { persistenceRoot: root },
    );
    try {
      const runId = "short-write";
      persistence.save(state(runId));
      expectCode(
        () => persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) }),
        "IO_ERROR",
      );
      assert.equal(writes, 1);
      assert.equal(closes, 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "non-ENOENT sidecar failures are IO_ERROR with their original cause",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ap-run-events-io-cwd-"));
    const root = mkdtempSync(join(tmpdir(), "ap-run-events-io-root-"));
    const cause = Object.assign(new Error("denied"), { code: "EACCES" });
    const persistence = createRunPersistence(
      cwd,
      {
        readFileSync: ((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
          if (String(path).endsWith(".events.jsonl")) throw cause;
          return (readFileSync as (...inner: unknown[]) => unknown)(path, ...args);
        }) as typeof readFileSync,
      },
      { persistenceRoot: root },
    );
    try {
      persistence.save(state("io-error"));
      const error = expectCode(() => persistence.readEvents("io-error"), "IO_ERROR");
      assert.equal(error.cause, cause);
      assert.ok(error.path?.endsWith("io-error.events.jsonl"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

class FakeWatcher extends EventEmitter {
  closed = 0;
  unrefed = 0;

  close(): void {
    this.closed++;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    this.unrefed++;
    return this;
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

test(
  "watchEvents is pull-based, drains backlog, recovers coalesced changes, and releases resources",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ap-run-events-watch-cwd-"));
    const root = mkdtempSync(join(tmpdir(), "ap-run-events-watch-root-"));
    const watchers: FakeWatcher[] = [];
    const watchCallbacks: Array<() => void> = [];
    const intervalCallbacks: Array<() => void> = [];
    const clearedTimers: unknown[] = [];
    let timerUnrefs = 0;
    const fakeWatch = ((_path: unknown, callback: () => void) => {
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      watchCallbacks.push(callback);
      return watcher as unknown as FSWatcher;
    }) as typeof watch;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((callback: () => void) => {
      intervalCallbacks.push(callback);
      return {
        unref() {
          timerUnrefs++;
        },
      } as NodeJS.Timeout;
    }) as typeof setInterval;
    globalThis.clearInterval = ((timer: unknown) => {
      clearedTimers.push(timer);
    }) as typeof clearInterval;
    try {
      const persistence = createRunPersistence(cwd, { watch: fakeWatch }, { persistenceRoot: root });
      const runId = "watch-stream";
      persistence.save(state(runId));
      persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) });

      const stream = persistence.watchEvents(runId);
      assert.equal(stream.streamId, STREAM_A);
      assert.equal(stream.closed, false);
      assert.equal(watchers[0]?.unrefed, 1);
      assert.equal(timerUnrefs, 1);
      assert.equal((await stream.next()).value?.seq, 1);

      const notificationPending = stream.next();
      await assert.rejects(stream.next(), TypeError);
      persistence.appendEvent(runId, { seq: 2, timestamp: TIMESTAMP, event: stopped(runId) });
      watchCallbacks[0]!();
      assert.equal((await notificationPending).value?.seq, 2);

      const recoveryPending = stream.next();
      persistence.appendEvent(runId, { seq: 3, timestamp: TIMESTAMP, event: stopped(runId) });
      intervalCallbacks[0]!();
      assert.equal((await recoveryPending).value?.seq, 3);

      const closePending = stream.next();
      stream.close();
      assert.deepEqual(await closePending, { done: true, value: undefined });
      assert.equal(stream.closed, true);
      assert.deepEqual(await stream.next(), { done: true, value: undefined });
      assert.deepEqual(await stream.return("ignored"), { done: true, value: undefined });
      assert.equal(watchers[0]?.closed, 1);
      assert.equal(clearedTimers.length, 1);

      const controller = new AbortController();
      const aborted = persistence.watchEvents(runId, { after: 3, signal: controller.signal });
      const abortPending = aborted.next();
      controller.abort();
      assert.deepEqual(await abortPending, { done: true, value: undefined });
      assert.equal(aborted.closed, true);

      const alreadyAbortedController = new AbortController();
      alreadyAbortedController.abort();
      const alreadyAborted = persistence.watchEvents(runId, { after: 3, signal: alreadyAbortedController.signal });
      assert.equal(alreadyAborted.closed, true);
      assert.deepEqual(await alreadyAborted.next(), { done: true, value: undefined });
      assert.equal(watchers.every((watcher) => watcher.closed === 1), true);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "watchers pin their generation and fail closed across sidecar deletion and immediate recreation",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ap-run-events-pin-cwd-"));
    const root = mkdtempSync(join(tmpdir(), "ap-run-events-pin-root-"));
    const callbacks: Array<() => void> = [];
    const watchers: FakeWatcher[] = [];
    const fakeWatch = ((_path: unknown, callback: () => void) => {
      const watcher = new FakeWatcher();
      callbacks.push(callback);
      watchers.push(watcher);
      return watcher as unknown as FSWatcher;
    }) as typeof watch;
    try {
      const persistence = createRunPersistence(cwd, { watch: fakeWatch }, { persistenceRoot: root });

      const deletedRun = "watch-deleted";
      persistence.save(state(deletedRun));
      persistence.appendEvent(deletedRun, { seq: 1, timestamp: TIMESTAMP, event: stopped(deletedRun) });
      persistence.save(state(deletedRun, { eventSeq: 1 }));
      const deletedStream = persistence.watchEvents(deletedRun, { after: 1 });
      const deletedPending = deletedStream.next();
      unlinkSync(join(persistence.getRunsDir(), `${deletedRun}.events.jsonl`));
      callbacks[0]!();
      await assert.rejects(deletedPending, (error) => error instanceof RunEventLogError && error.code === "SNAPSHOT_AHEAD");
      assert.equal(deletedStream.closed, true);
      assert.deepEqual(await deletedStream.next(), { done: true, value: undefined });

      const recreatedRun = "watch-recreated";
      persistence.save(state(recreatedRun));
      persistence.appendEvent(recreatedRun, { seq: 1, timestamp: TIMESTAMP, event: stopped(recreatedRun) });
      const recreatedStream = persistence.watchEvents(recreatedRun, { after: 1 });
      const recreatedPending = recreatedStream.next();
      persistence.save(state(recreatedRun, { eventStreamId: STREAM_B, eventSeq: 0 }));
      callbacks[1]!();
      await assert.rejects(recreatedPending, (error) => error instanceof RunEventLogError && error.code === "STREAM_MISMATCH");
      assert.equal(recreatedStream.closed, true);
      assert.equal(watchers.every((watcher) => watcher.closed === 1), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "createRunPersistence is already event-capable and default deletion removes its sidecar",
  withPersistence(({ persistence, eventPath }) => {
    assert.equal(withRunEvents(persistence), persistence);
    const runId = "delete-order";
    persistence.save(state(runId));
    persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) });
    assert.equal(statSync(eventPath(runId)).isFile(), true);
    assert.equal(persistence.delete(runId), true);
    assert.throws(() => statSync(eventPath(runId)), (error) => (error as { code?: string }).code === "ENOENT");
  }),
);

{
  const deletions: string[] = [];
  test(
    "default deletion orders the event sidecar before snapshots and removes the writer lock last",
    withPersistence(
      ({ persistence }) => {
        const runId = "ordered-delete";
        persistence.save(state(runId));
        const lease = persistence.acquireRunLease(runId);
        assert.ok(lease);
        persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) });
        assert.equal(persistence.delete(runId), true);
        const eventIndex = deletions.findIndex((path) => path.endsWith(`${runId}.events.jsonl`));
        const snapshotIndex = deletions.findIndex((path) => path.endsWith(`${runId}.json`));
        const backupIndex = deletions.findIndex((path) => path.endsWith(`${runId}.json.bak`));
        const lockIndex = deletions.findIndex((path) => path.endsWith(`${runId}.lock`));
        assert.ok(eventIndex >= 0 && snapshotIndex > eventIndex);
        assert.ok(backupIndex > snapshotIndex);
        assert.equal(lockIndex, deletions.length - 1);
      },
      {
        unlinkSync: ((path: Parameters<typeof unlinkSync>[0]) => {
          deletions.push(String(path));
          unlinkSync(path);
        }) as typeof unlinkSync,
      },
    ),
  );
}

test("withRunEvents wraps structural persistence once, delegates it, and deletes the sidecar first", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "ap-run-events-custom-"));
  const snapshots = new Map<string, PersistedRunState>();
  let sidecarPresentWhenDelete: boolean | undefined;
  let releaseCalls = 0;
  const custom: RunPersistence & { appendEvent(): never } = {
    save(snapshot) {
      snapshots.set(snapshot.runId, structuredClone(snapshot));
    },
    load(runId) {
      const snapshot = snapshots.get(runId);
      return snapshot === undefined ? null : structuredClone(snapshot);
    },
    list() {
      return [...snapshots.values()].map((snapshot) => structuredClone(snapshot));
    },
    delete(runId) {
      sidecarPresentWhenDelete = existsSync(join(runsDir, `${runId}.events.jsonl`));
      snapshots.delete(runId);
      return false;
    },
    acquireRunLease(runId) {
      return { runId, token: "custom" };
    },
    releaseRunLease() {
      releaseCalls++;
    },
    getRunsDir() {
      return runsDir;
    },
    appendEvent() {
      throw new Error("structural lookalike must not be trusted");
    },
  };
  try {
    const persistence = withRunEvents(custom);
    assert.notEqual(persistence, custom);
    assert.equal(withRunEvents(persistence), persistence);
    const runId = "custom-wrapper";
    persistence.save(state(runId));
    assert.equal(persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) }).seq, 1);
    persistence.releaseRunLease({ runId, token: "custom" });
    assert.equal(releaseCalls, 1);
    assert.equal(persistence.appendEvent(runId, { seq: 2, timestamp: TIMESTAMP, event: stopped(runId) }).seq, 2);
    assert.equal(persistence.delete(runId), false);
    assert.equal(sidecarPresentWhenDelete, false);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});
