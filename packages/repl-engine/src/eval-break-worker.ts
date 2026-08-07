/**
 * The eval-break channel's worker thread (see `eval-break-channel.ts`):
 * owns the break flags' write side — a loopback HTTP endpoint the MCP
 * shim can reach while the daemon's main thread is blocked in a
 * synchronous eval. The worker's event loop is a separate thread, so it
 * never blocks with the daemon.
 *
 * Wire contract: `POST /break` with a JSON body `{ "key": "<workspace
 * key>" }` arms the key's flag (arm sequence first, generation second,
 * flag last — release order, so a consumed flag always carries its arm
 * sequence AND the arming key's generation); 204 when the key is
 * registered, 404 otherwise. `{ type: "register", key, slot, gen }`
 * messages from the main thread teach the key→slot mapping and are
 * ACKNOWLEDGED with `{ type: "ack", key, slot, gen }` once applied (the
 * channel's registration gate — phase-F review round 4); the slot's
 * flag is cleared as the mapping takes it over (an arm still in flight
 * for the slot's previous key must never break the new key), and the
 * slot's generation word is set to the new key's generation.
 * `{ type: "unregister", key }` drops the mapping (the slot returns to
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
/** The applied key→slot mapping: slot + the generation the mapping was
 *  assigned under (written into the shared slot on every arm — the
 *  main thread's consume drops an arm whose generation does not match
 *  the consuming key's current one). */
const slotsByKey = new Map<string, { slot: number; gen: number }>();

function slotFlagWord(slot: number): number {
  return 1 + 3 * slot;
}

function slotSeqWord(slot: number): number {
  return 1 + 3 * slot + 1;
}

function slotGenWord(slot: number): number {
  return 1 + 3 * slot + 2;
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
    const entry = slotsByKey.get(key);
    if (entry === undefined) {
      res.writeHead(404).end();
      return;
    }
    // Release order: the arm's sequence and the ARMING key's generation
    // are visible before the flag. The sequence is the SHARED monotonic
    // arm counter (word 0) — a total order across this thread and the
    // main thread, so a break armed after an execution began always
    // carries a greater sequence than the execution's start marker (no
    // clock-resolution window — the phase-F review round 3
    // same-millisecond loss is impossible). The generation is the
    // fence against slot reuse: a consume under a LATER generation of
    // this slot drops the arm (phase-F review round 4 — see
    // `consumeBreak` in the channel).
    const seq = Atomics.add(view, 0, 1) + 1;
    Atomics.store(view, slotSeqWord(entry.slot), seq);
    Atomics.store(view, slotGenWord(entry.slot), entry.gen);
    Atomics.store(view, slotFlagWord(entry.slot), 1);
    res.writeHead(204).end();
  });
});

parentPort?.on("message", (message: { type?: string; key?: string; slot?: number; gen?: number }) => {
  if (
    message.type === "register" &&
    typeof message.key === "string" &&
    typeof message.slot === "number" &&
    typeof message.gen === "number"
  ) {
    // The mapping takes the slot over: clear any flag an in-flight arm
    // for the slot's PREVIOUS key left behind (the worker can still
    // hold the released mapping until the unregister message lands) and
    // stamp the slot with the new key's generation — a stale arm can
    // never break the new key (the main thread's consume also drops it
    // on the generation mismatch; the clear makes it vanish entirely).
    slotsByKey.set(message.key, { slot: message.slot, gen: message.gen });
    Atomics.store(view, slotFlagWord(message.slot), 0);
    Atomics.store(view, slotGenWord(message.slot), message.gen);
    // The ACKNOWLEDGEMENT (phase-F review round 4): the mapping is
    // APPLIED — the channel's registration promise resolves only now,
    // so the broker never runs guest code against an unapplied
    // mapping.
    parentPort?.postMessage({ type: "ack", key: message.key, slot: message.slot, gen: message.gen });
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
