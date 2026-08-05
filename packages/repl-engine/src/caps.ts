/**
 * Output caps for the `repl` tool result — the doc's limits: **256 lines or
 * 10 KB per tool result, whichever trips first**. Everything beyond the
 * cap remains reachable through the `$N` refs the capped lines carry (the
 * cap costs reads, never data).
 *
 * The cap is line-granular: a line that would trip either limit is not
 * emitted at all (no partial lines), and `truncated` reports that more
 * output exists. Byte accounting uses UTF-8 and counts the `\n` separators
 * of the canonical serialization (lines joined with `\n`, no trailing
 * newline) — so the cap matches what the client agent actually receives.
 *
 * The 10 KB unit is decimal (10 × 1000 bytes), consistent with the
 * preview format's byte-size convention (FORMAT.md §2.2 uses ×1000 units).
 */

/** Maximum lines per tool result. */
export const OUTPUT_MAX_LINES = 256;
/** Maximum bytes per tool result (10 KB, decimal units). */
export const OUTPUT_MAX_BYTES = 10 * 1000;

/** The capped result of `applyOutputCaps`. */
export interface OutputCapResult {
  /** The lines that fit under both caps, in order. */
  lines: string[];
  /** True when lines were dropped (more output exists, reachable via $N). */
  truncated: boolean;
}

/**
 * Apply the doc's output caps to a list of rendered lines: emit lines in
 * order while both caps hold, stop at the first line that would trip
 * either, and report truncation.
 */
export function applyOutputCaps(lines: string[]): OutputCapResult {
  const out: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    // The '\n' separator is counted between lines (canonical serialization).
    const separatorBytes = out.length > 0 ? 1 : 0;
    const lineBytes = Buffer.byteLength(line, 'utf8') + separatorBytes;
    if (out.length >= OUTPUT_MAX_LINES || bytes + lineBytes > OUTPUT_MAX_BYTES) {
      return { lines: out, truncated: true };
    }
    bytes += lineBytes;
    out.push(line);
  }
  return { lines: out, truncated: false };
}
