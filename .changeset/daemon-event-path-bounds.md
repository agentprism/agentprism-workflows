---
"@automatalabs/workflow-engine": patch
---

Bound the run event log's read and watch paths so a large journal no longer blocks the daemon.

Previously every `readEvents` re-read and re-parsed the whole `events.jsonl` — a fatal UTF-8
decode, `JSON.parse`, a canonical re-`stringify` comparison, per-record shape validation, and a
stateful semantic pass over *every* record — and `watchEvents` did one such full re-parse per
record it yielded. On a real 9.7 MB / 18,193-record incident journal that measured ≈270 ms for a
single read and ≈115.8 s of synchronous main-thread work to catch a watcher up by 500 records,
which starved bounded `await`s and the daemon's `/healthz` probe and drove two daemon respawns.

The writer now keeps a per-run, fully validated in-memory view of its own journal, advanced in
O(bytes-written) on `appendEvent`, and `readEvents`/`watchEvents` serve from it: a read re-reads
the file and verifies the already-validated prefix with a cheap rolling fingerprint, parsing only
the never-before-seen suffix; a watcher yields cached records in O(1) each and is woken in-process
by the writer instead of re-parsing per record. Durability is unchanged — torn-tail repair,
stream-id and sequence checks, canonical-form and redaction validation, snapshot-watermark and
`reconcileExternallyDeadRun` behavior all still run, and a run this process never wrote is fully
validated once cold before any cached fast path is trusted. A long backlog drain now yields the
event loop on a time bound so `/healthz` and `await` timers stay answerable. No public contract,
event type, or file format changed. On a 20,000-record journal a 5,000-record watcher catch-up
drops from a projected ~865 s to ~3 ms.
