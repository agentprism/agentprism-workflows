/**
 * The eval-break channel's worker thread (see `eval-break-channel.ts`):
 * owns the break flags' write side — a loopback HTTP endpoint the MCP
 * shim can reach while the daemon's main thread is blocked in a
 * synchronous eval. The worker's event loop is a separate thread, so it
 * never blocks with the daemon.
 *
 * Wire contract: `POST /break` with a JSON body `{ "key": "<workspace
 * key>" }` arms the key's flag (arm sequence first, flag second —
 * release order, so a consumed flag always carries its arm sequence);
 * 204 when the key is registered, 404 otherwise. `{ type: "register",
 * key, slot }` messages from the main thread teach the key→slot
 * mapping; `{ type: "unregister", key }` drops it (the slot returns to
 * the main thread's free pool); `dispose` closes the server and exits.
 *
 * The shared buffer is RESIZABLE: the length-tracking `Int32Array` view
 * below follows the main thread's growth automatically, and the slot
 * stride is fixed, so no re-view handshake is ever needed.
 */

import { createServer } from "node:http";
import { parentPort, workerData } from "node:worker_threads";

interface WorkerData {
  sab: SharedArrayBuffer;
}

const { sab } = workerData as WorkerData;
const view = new Int32Array(sab);
const slotsByKey = new Map<string, number>();

function slotFlagWord(slot: number): number {
  return 1 + 2 * slot;
}

function slotSeqWord(slot: number): number {
  return 1 + 2 * slot + 1;
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/break") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    body += chunk;
  });
  req.on("end", () => {
    let key: unknown;
    try {
      key = (JSON.parse(body) as { key?: unknown }).key;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (typeof key !== "string") {
      res.writeHead(400).end();
      return;
    }
    const slot = slotsByKey.get(key);
    if (slot === undefined) {
      res.writeHead(404).end();
      return;
    }
    // Release order: the arm's sequence is visible before the flag. The
    // sequence is the SHARED monotonic arm counter (word 0) — a total
    // order across this thread and the main thread, so a break armed
    // after an execution began always carries a greater sequence than
    // the execution's start marker (no clock-resolution window — the
    // phase-F review round 3 same-millisecond loss is impossible).
    const seq = Atomics.add(view, 0, 1) + 1;
    Atomics.store(view, slotSeqWord(slot), seq);
    Atomics.store(view, slotFlagWord(slot), 1);
    res.writeHead(204).end();
  });
});

parentPort?.on("message", (message: { type?: string; key?: string; slot?: number }) => {
  if (message.type === "register" && typeof message.key === "string" && typeof message.slot === "number") {
    slotsByKey.set(message.key, message.slot);
    return;
  }
  if (message.type === "unregister" && typeof message.key === "string") {
    slotsByKey.delete(message.key);
    return;
  }
  if (message.type === "dispose") {
    server.close(() => process.exit(0));
    // A hanging keep-alive connection must not block exit.
    setTimeout(() => process.exit(0), 100).unref();
    return;
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  parentPort?.postMessage({ type: "ready", port });
});
