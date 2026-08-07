/**
 * The single-project (in-process) stdio transport with the REPL
 * eval-break relay — phase-F review round 3: the public in-process/
 * library server must implement the documented no-id interrupt behavior
 * for a SYNCHRONOUSLY running eval, not only the daemon mode.
 *
 * ## Why a transport at all
 *
 * The pre-daemon `--in-process` mode (and the library `main()` path)
 * serves MCP directly over stdio from the server's own process. A
 * `while (true) {}` eval blocks that process's main thread, so the
 * client's interrupt request sitting in the stdin pipe cannot be
 * PROCESSED — the documented "break a runaway eval" would be
 * unimplemented in this supported mode. The daemon mode closes the same
 * gap with a separate shim PROCESS that fires the eval-break relay
 * (a worker thread) before forwarding. In-process there is no shim
 * process, so this transport moves the STDIN READER into a worker
 * thread: the reader stays live while the main thread is wedged in the
 * VM, recognizes `repl` interrupt calls (no call id), fires the
 * server's out-of-band eval-break relay (the same `POST /break`
 * contract the shim uses), and forwards every raw frame to the main
 * thread for normal processing once the eval ends or breaks. The
 * per-eval wall-clock deadline remains the last-resort bound, exactly
 * like the daemon mode's.
 *
 * ## Frame discipline
 *
 * The reader worker parses each newline-delimited JSON-RPC frame only
 * to detect the interrupt; every frame — detected or not — is forwarded
 * verbatim to the main thread (the server's `onmessage`), so the
 * protocol layer sees a byte-identical stream to `StdioServerTransport`'s
 * and the single-project mode keeps its exact framing semantics. The
 * worker is the ONLY stdin reader (this transport replaces the SDK's
 * stdio transport), so there is no reader conflict.
 */

import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** The worker's EOF marker (the stdin pipe closed — the main thread
 *  closes the transport, mirroring `StdioServerTransport`'s close-on-
 *  stdin-end semantics). */
const EOF_MARKER = "\u0000__repl_stdio_eof__\u0000";

/** The relay worker entry: the compiled `repl-stdio-relay-worker.js` in
 *  dist, or the TypeScript source when running from src (tsx dev/tests —
 *  the worker inherits the parent's loader, so the .ts runs directly). */
function relayWorkerEntryUrl(): URL {
  const tsEntry = new URL("./repl-stdio-relay-worker.ts", import.meta.url);
  if (existsSync(fileURLToPath(tsEntry))) return tsEntry;
  return new URL("./repl-stdio-relay-worker.js", import.meta.url);
}

/**
 * The stdio transport whose stdin reader lives on a worker thread and
 * fires the REPL eval-break relay for `repl` interrupt calls without a
 * call id (see the module docs). `breakUrlSource` supplies the relay
 * address (the server's owned eval-break channel); it is resolved at
 * `start()` — the channel's worker boots in milliseconds, and a relay
 * that never becomes available degrades to the per-eval deadline bound
 * (the transport still forwards every frame).
 */
export class ReplRelayStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly breakUrlSource: () => Promise<string>;
  private worker: Worker | undefined;
  private started = false;
  private closed = false;

  constructor(breakUrlSource: () => Promise<string>) {
    this.breakUrlSource = breakUrlSource;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const breakUrl = await this.breakUrlSource().catch(() => undefined);
    if (this.closed) return;
    this.worker = new Worker(relayWorkerEntryUrl(), {
      workerData: { breakUrl },
    });
    this.worker.unref();
    this.worker.on("message", (payload: string) => {
      if (payload === EOF_MARKER) {
        void this.close();
        return;
      }
      try {
        this.onmessage?.(JSON.parse(payload) as JSONRPCMessage);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.worker.on("error", (error) => this.onerror?.(error));
    this.worker.on("exit", () => {
      if (!this.closed) void this.close();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // stdout stays on the main thread (a blocked main thread is not
    // sending anything anyway — the eval's result is only produced
    // after the execution ends).
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const worker = this.worker;
    this.worker = undefined;
    if (worker !== undefined) {
      await worker.terminate().catch(() => undefined);
    }
    this.onclose?.();
  }
}
