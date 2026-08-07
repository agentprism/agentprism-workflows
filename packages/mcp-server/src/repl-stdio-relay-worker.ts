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
 * skipped — the server's own validation refuses the call. An interrupt
 * that OMITS projectDir fires the relay with the SINGLE-PROJECT
 * SERVER'S OWN PROJECT KEY (phase-F review round 4: the repl tool
 * resolves the omitted projectDir to the registry's adopted default
 * context, so the relay must too — the old code skipped the relay
 * entirely, and the runaway eval ran to the per-eval deadline before
 * the interrupt could be processed). EOF on stdin posts the EOF
 * marker; the transport closes.
 *
 * ## Decoding discipline
 *
 * The raw byte stream is decoded through a STREAMING UTF-8 decoder
 * (`StringDecoder`), never per-chunk `Buffer.toString`: a multibyte
 * character split across two reads must survive intact — the frame
 * forwarding is byte-identical, and a per-chunk decode replaced the
 * split character with U+FFFD, corrupting the JSON-RPC payload
 * (phase-F review round 4: a multibyte payload's decoded length
 * changed on the wire).
 */

import { readSync } from "node:fs";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parentPort, workerData } from "node:worker_threads";

interface WorkerData {
  breakUrl?: string;
  /** The single-project server's own project key — the context the
   *  repl tool resolves when projectDir is omitted (`stores()[0]`).
   *  Undefined in daemon mode (projectDir is required there) and when
   *  the transport has no default project. */
  defaultProjectKey?: string;
}

const EOF_MARKER = "\u0000__repl_stdio_eof__\u0000";
// `workerData` is null outside a worker thread (the unit tests import
// this module in the main thread) — the defaults keep the relay inert.
const { breakUrl, defaultProjectKey } = (workerData ?? {}) as WorkerData;
const READ_CHUNK = 64 * 1024;
/** The EAGAIN retry yield: the pipe is momentarily empty — check again
 *  shortly (the worker's only jobs are this pump and the relay's
 *  fire-and-forget fetch, so a few milliseconds of slack is nothing). */
const EAGAIN_RETRY_MS = 5;

/** The newline-delimited frame splitter: decodes the raw byte stream
 *  through a STREAMING UTF-8 decoder (a multibyte character split
 *  across reads must not be corrupted — phase-F review round 4: the
 *  per-chunk `Buffer.toString("utf8")` replaced the split character
 *  with U+FFFD, so the claimed byte-identical forwarding was false for
 *  multibyte payloads) and emits complete lines. Exported for the unit
 *  tests; the module is import-safe outside a worker because the pump
 *  only runs when `parentPort` is present. */
export class RelayFrameSplitter {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";

  constructor(private readonly onLine: (line: string) => void) {}

  /** Decode one read chunk and emit every complete line it contains. */
  push(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    for (;;) {
      const newline = this.pending.indexOf("\n");
      if (newline < 0) break;
      this.onLine(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
    }
  }

  /** EOF: flush the decoder's held partial character (a TRUNCATED
   *  UTF-8 sequence at the stream's end decodes to the replacement
   *  char) and emit a final unterminated frame, if any. */
  end(): void {
    this.pending += this.decoder.end();
    if (this.pending.length > 0) {
      const line = this.pending;
      this.pending = "";
      this.onLine(line);
    }
  }
}

/** Resolve the relay key for one interrupt call: the REALPATH'd
 *  projectDir (exactly the daemon's canonical project key — a symlink
 *  or non-normalized path must reach the workspace's registered key),
 *  or — when projectDir is OMITTED — the single-project server's own
 *  project key, VERBATIM (the repl tool resolves the omitted projectDir
 *  to the registry's adopted default context, and the broker registers
 *  that context's projectDir as-is; phase-F review round 4). `undefined`
 *  when the call cannot be keyed at all (non-absolute or unresolvable
 *  path, or no default key available) — the server's own validation
 *  refuses the call, or the transport has no default project. Exported
 *  for the unit tests. */
export function relayBreakKey(
  projectDir: unknown,
  defaultProjectKey: string | undefined,
): string | undefined {
  if (typeof projectDir === "string") {
    if (!isAbsolute(projectDir)) return undefined;
    try {
      return realpathSync(projectDir);
    } catch {
      return undefined; // invalid/unresolvable — the server's own validation refuses the call
    }
  }
  // projectDir omitted — single-project mode (round 4: the relay used
  // to skip the omitted-projectDir interrupt entirely, so the runaway
  // eval ran to the per-eval deadline and the interrupt then reported
  // refused-idle).
  return defaultProjectKey;
}

/** Fire the out-of-band break (best-effort, fire-and-forget: the
 *  server's own interrupt processing clears the flag when it lands; a
 *  dead relay degrades to the per-eval deadline bound). */
function fireOutOfBandBreak(projectDir: unknown): void {
  if (breakUrl === undefined) return;
  const key = relayBreakKey(projectDir, defaultProjectKey);
  if (key === undefined) return;
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
 *  EAGAIN discipline), split the newline-delimited frame stream through
 *  the STREAMING UTF-8 decoder, and handle each line. EOF (a
 *  zero-length read) posts the EOF marker and stops. A fatal read error
 *  is reported to the parent and stops the pump — the transport then
 *  closes like any broken pipe. */
function pump(): void {
  const buffer = Buffer.alloc(READ_CHUNK);
  const readOnce = (): number => readSync(0, buffer, 0, READ_CHUNK, null);
  const splitter = new RelayFrameSplitter(handleLine);
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
      // EOF: flush a final unterminated frame (a truncated multibyte
      // sequence at the stream's end decodes to the replacement char),
      // then close the transport.
      splitter.end();
      parentPort?.postMessage(EOF_MARKER);
      return;
    }
    splitter.push(buffer.subarray(0, n));
    step();
  };
  step();
}

// The pump owns fd 0 and only runs inside the worker thread — importing
// this module in the main thread (the unit tests) must not touch stdin
// (`parentPort` is null there).
if (parentPort !== null) pump();
