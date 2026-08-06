/**
 * The eval-break channel's worker thread (see `eval-break-channel.ts`):
 * owns the break flags' write side — a loopback HTTP endpoint the MCP
 * shim can reach while the daemon's main thread is blocked in a
 * synchronous eval. The worker's event loop is a separate thread, so it
 * never blocks with the daemon.
 *
 * Wire contract: `POST /break` with a JSON body `{ "key": "<workspace
 * key>" }` arms the key's flag (timestamp first, flag second — release
 * order, so a consumed flag always carries its arm moment); 204 when
 * the key is registered, 404 otherwise. `{ type: "register", key, slot }`
 * messages from the main thread teach the key→slot mapping; `dispose`
 * closes the server and exits.
 */

import { createServer } from "node:http";
import { parentPort, workerData } from "node:worker_threads";

interface WorkerData {
  sab: SharedArrayBuffer;
}

const { sab } = workerData as WorkerData;
const SLOTS = 64;
const flags = new Int32Array(sab, 0, SLOTS);
const times = new Float64Array(sab, SLOTS * 4, SLOTS);
const slotsByKey = new Map<string, number>();

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
    // Release order: the arm moment is visible before the flag.
    times[slot] = Date.now();
    Atomics.store(flags, slot, 1);
    res.writeHead(204).end();
  });
});

parentPort?.on("message", (message: { type?: string; key?: string; slot?: number }) => {
  if (message.type === "register" && typeof message.key === "string" && typeof message.slot === "number") {
    slotsByKey.set(message.key, message.slot);
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
