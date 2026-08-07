/**
 * Phase-F review round 4 pins for the in-process relay worker
 * (`repl-stdio-relay-worker.ts`):
 *
 * - the STREAMING UTF-8 decoder: a multibyte character split across two
 *   reads survives intact (the old per-chunk `Buffer.toString("utf8")`
 *   replaced the split character with U+FFFD, so the claimed
 *   byte-identical MCP forwarding was false for multibyte payloads —
 *   the built-server repro changed an expected string length),
 * - the relay KEY resolution: an interrupt that OMITS projectDir fires
 *   with the single-project server's own project key, verbatim (the
 *   repl tool resolves the omitted projectDir to the registry's adopted
 *   default context, whose projectDir the broker registers as-is);
 *   an explicit projectDir is realpath'd exactly like the daemon's
 *   project validation.
 *
 * Importing the module in the main thread is safe: the stdin pump only
 * runs when `parentPort` is present (i.e. inside the worker thread).
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RelayFrameSplitter, relayBreakKey } from "../src/repl-stdio-relay-worker.js";

test("the frame splitter decodes a MULTIBYTE character split across reads intact (round 4: per-chunk decoding corrupted it with U+FFFD)", () => {
  const lines: string[] = [];
  const splitter = new RelayFrameSplitter((line) => lines.push(line));
  // A JSON-RPC frame whose payload contains 4-byte emoji, delivered
  // ONE BYTE AT A TIME — every multibyte character straddles reads.
  const emoji = "\u{1F600}";
  const code = `"${emoji}${emoji}${emoji}" ('x'.repeat(3)).length; "${emoji}".repeat(200)`;
  const frame = JSON.stringify({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "repl", arguments: { action: "eval", projectDir: "/tmp/w", code } },
  });
  const bytes = Buffer.from(frame, "utf8");
  for (const byte of bytes) splitter.push(Buffer.from([byte]));
  splitter.end();
  assert.equal(lines.length, 1, "the split frame is emitted as exactly one line");
  assert.equal(lines[0], frame, "the decoded line is byte-identical to the original frame text");
  assert.ok(!lines[0].includes("\uFFFD"), "no replacement characters anywhere in the decoded frame");
  // The decoded frame is the TRUE payload: the JSON parses, and the
  // guest-facing string is verbatim (the round-4 repro: a corrupted
  // decode changed an expected JavaScript string length of 40001 to
  // 40003).
  const parsed = JSON.parse(lines[0]) as {
    params?: { arguments?: { code?: string } };
  };
  assert.equal(parsed.params!.arguments!.code, code, "the split multibyte payload decodes verbatim");
});

test("the splitter flushes a final unterminated frame at EOF and emits lines split across arbitrary chunk boundaries", () => {
  const lines: string[] = [];
  const splitter = new RelayFrameSplitter((line) => lines.push(line));
  const a = '{"jsonrpc":"2.0","method":"ping","id":1}\n';
  const b = '{"jsonrpc":"2.0","method":"ping","id":2}'; // no trailing newline
  const stream = Buffer.from(a + b, "utf8");
  // Two frames delivered in awkward halves (the newline falls inside
  // the second push, the final frame is unterminated until EOF).
  const half = Math.floor(stream.length / 2);
  splitter.push(stream.subarray(0, half));
  splitter.push(stream.subarray(half));
  splitter.end();
  assert.deepEqual(lines, [a.trim(), b], "each complete line is emitted; EOF flushes the final unterminated frame");
});

test("the relay key for an OMITTED projectDir is the server's own project key, verbatim (round 4)", () => {
  const home = mkdtempSync(join(tmpdir(), "agentprism-repl-relay-key-"));
  try {
    const realDir = join(home, "real");
    const symDir = join(home, "linked");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, symDir, "dir");
    // The single-project default context's projectDir is adopted
    // VERBATIM (the broker registers it as-is; the tool's omitted-
    // projectDir resolution returns `stores()[0].projectDir` raw) — so
    // even a symlinked cwd must be posted as-is, not realpath'd.
    assert.equal(relayBreakKey(undefined, symDir), symDir, "the omitted projectDir fires with the verbatim default key");
    assert.equal(relayBreakKey(undefined, realDir), realDir);
    // No default key available (daemon mode, or no adopted context):
    // the call cannot be keyed — the relay is skipped.
    assert.equal(relayBreakKey(undefined, undefined), undefined);
    assert.equal(relayBreakKey(undefined, ""), "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the relay key for an EXPLICIT projectDir is realpath'd exactly like the daemon's project validation", () => {
  const home = mkdtempSync(join(tmpdir(), "agentprism-repl-relay-key-"));
  try {
    const realDir = join(home, "real-project");
    const symDir = join(home, "linked-project");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, symDir, "dir");
    assert.equal(relayBreakKey(symDir, undefined), realDir, "a symlinked projectDir realpaths to the canonical key");
    assert.equal(relayBreakKey(realDir, undefined), realDir);
    // Non-absolute and unresolvable paths cannot be keyed (the server's
    // own validation refuses the call).
    assert.equal(relayBreakKey("relative/path", undefined), undefined);
    assert.equal(relayBreakKey(join(home, "does-not-exist"), undefined), undefined);
    assert.equal(relayBreakKey(42, undefined), undefined);
    assert.equal(relayBreakKey(null, undefined), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
