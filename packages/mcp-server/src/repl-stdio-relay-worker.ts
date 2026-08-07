/**
 * The `ReplRelayStdioTransport`'s worker thread (see
 * `repl-stdio-transport.ts`): owns the STDIN READ of the single-project
 * in-process MCP server, so a `repl` interrupt can reach the
 * out-of-band eval-break relay while the main thread is blocked in a
 * synchronous eval (the daemon mode's shim does the same from a
 * separate process; here the reader thread plays the shim's fire side).
 *
 * ## Reading stdin from a worker thread
 *
 * `process.stdin` in a worker thread is NOT wired to the real fd (it
 * reports EOF immediately), and `fs.read` on the raw fd 0 returns
 * EAGAIN whenever the pipe is momentarily empty — libuv's child stdio
 * pipes are non-blocking — which a naive read stream treats as fatal.
 * The pump below therefore reads fd 0 directly and treats EAGAIN as
 * "no data right now": it yields for a few milliseconds and retries,
 * so the worker's event loop stays free for the relay's fire-and-forget
 * fetch between lines. A blocking fd (a shell pipe, a terminal) simply
 * blocks in the read until data or EOF arrives.
 *
 * ## Wire contract
 *
 * Every newline-delimited JSON-RPC frame is forwarded VERBATIM to the
 * main thread. A `tools/call` frame for the `repl` tool with
 * `action: "interrupt"` and NO call id additionally fires the relay
 * first — `POST /break` with the REALPATH'd `key` (exactly the daemon's
 * canonical project key, phase-F review round 3: the raw caller-
 * supplied path used to be posted verbatim, so a symlinked or
 * non-normalized projectDir got a relay 404). An unresolvable path is
 * skipped — the server's own validation refuses the call. EOF on stdin
 * posts the EOF marker; the transport closes.
 */

import { readSync } from "node:fs";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

interface WorkerData {
  breakUrl?: string;
}

const EOF_MARKER = "\u0000__repl_stdio_eof__\u0000";
const { breakUrl } = workerData as WorkerData;
const READ_CHUNK = 64 * 1024;
/** The EAGAIN retry yield: the pipe is momentarily empty — check again
 *  shortly (the worker's only jobs are this pump and the relay's
 *  fire-and-forget fetch, so a few milliseconds of slack is nothing). */
const EAGAIN_RETRY_MS = 5;

/** Fire the out-of-band break (best-effort, fire-and-forget: the
 *  server's own interrupt processing clears the flag when it lands; a
 *  dead relay degrades to the per-eval deadline bound). The key is
 *  realpath'd exactly like the daemon's project validation. */
function fireOutOfBandBreak(projectDir: unknown): void {
  if (typeof projectDir !== "string" || breakUrl === undefined) return;
  let key: string;
  try {
    if (!isAbsolute(projectDir)) return;
    key = realpathSync(projectDir);
  } catch {
    return; // invalid/unresolvable — the server's own validation refuses the call
  }
  void fetch(breakUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
    signal: AbortSignal.timeout(1000),
  }).catch(() => {
    // Best-effort: a dead relay must never break the forwarding path.
  });
}

/** Handle one complete line: detect the repl interrupt and fire the
 *  relay, then forward the RAW frame verbatim. */
function handleLine(line: string): void {
  if (parentPort !== null) {
    // Parse only to detect the interrupt; the raw frame is forwarded
    // either way.
    try {
      const message = JSON.parse(line) as {
        method?: unknown;
        params?: { name?: unknown; arguments?: Record<string, unknown> };
      };
      if (
        message.method === "tools/call" &&
        message.params?.name === "repl" &&
        message.params.arguments?.action === "interrupt" &&
        message.params.arguments.id === undefined
      ) {
        fireOutOfBandBreak(message.params.arguments.projectDir);
      }
    } catch {
      // Not a JSON-RPC frame — forward verbatim below.
    }
    parentPort.postMessage(line);
  }
}

/** The stdin pump: read fd 0 directly (see the module docs for the
 *  EAGAIN discipline), split the newline-delimited frame stream, and
 *  handle each line. EOF (a zero-length read) posts the EOF marker and
 *  stops. A fatal read error is reported to the parent and stops the
 *  pump — the transport then closes like any broken pipe. */
function pump(): void {
  const buffer = Buffer.alloc(READ_CHUNK);
  const readOnce = (): number => readSync(0, buffer, 0, READ_CHUNK, null);
  let pending = "";
  const step = (): void => {
    let n: number;
    try {
      n = readOnce();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") {
        setTimeout(step, EAGAIN_RETRY_MS);
        return;
      }
      parentPort?.postMessage(`\u0000__repl_stdio_error__\u0000${String(error)}`);
      return;
    }
    if (n === 0) {
      // EOF: flush a final unterminated frame, then close the transport.
      if (pending.length > 0) handleLine(pending);
      parentPort?.postMessage(EOF_MARKER);
      return;
    }
    pending += buffer.toString("utf8", 0, n);
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      handleLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
    step();
  };
  step();
}

pump();
