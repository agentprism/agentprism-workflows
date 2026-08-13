/**
 * Output caps for the `repl` tool result — the limits: **4000 lines or
 * 50 KB per tool result, whichever trips first**. Everything beyond the
 * cap remains reachable through the `$N` refs the capped lines carry (the
 * cap costs reads, never data).
 *
 * The cap is line-granular: a line that would trip either limit is not
 * emitted at all (no partial lines), and `truncated` reports that more
 * output exists. Byte accounting uses UTF-8 and counts the `\n` separators
 * of the canonical serialization (lines joined with `\n`, no trailing
 * newline) — so the cap matches what the client agent actually receives.
 *
 * The line cap counts PHYSICAL lines, not array entries: a rendered
 * line may itself contain embedded `\n` characters — the previewer
 * renders property names verbatim (FORMAT.md §5.18), so a name carrying
 * 300 line feeds reaches the tool result as 301 physical lines inside ONE
 * rendered line (review regression: the entry was retained whole with
 * `truncated: false`, silently shipping 301 serialized lines). Both caps
 * therefore account for the line's own content, embedded newlines
 * included (Buffer.byteLength already counts them for the byte cap;
 * `countPhysicalLines` counts them for the line cap).
 *
 * The BYTE cap (50 KB) is the load-bearing bound: a directly emitted
 * top-level string — a `console.log` argument or the eval result — is
 * carried whole up to this budget, so a subagent's answer arrives in one
 * call instead of being clamped to a 200-char preview. The LINE cap is a
 * flood guard that
 * must therefore be generous enough not to truncate a single up-to-50 KB
 * multi-line emission before the byte cap does: a 50 KB markdown answer is
 * one rendered line whose embedded newlines make it hundreds-to-thousands
 * of physical lines. 4000 keeps the byte budget the real bound for any
 * emission averaging ≥ ~13 bytes/line while still capping a pathological
 * all-newline flood.
 *
 * The 50 KB unit is decimal (50 × 1000 bytes), consistent with the
 * preview format's byte-size convention (FORMAT.md §2.2 uses ×1000 units).
 */

/** Maximum lines per tool result. */
export const OUTPUT_MAX_LINES = 4000;
/** Maximum bytes per tool result (50 KB, decimal units). */
export const OUTPUT_MAX_BYTES = 50 * 1000;

/** The capped result of `applyOutputCaps`. */
export interface OutputCapResult {
  /** The lines that fit under both caps, in order. */
  lines: string[];
  /** True when lines were dropped (more output exists, reachable via $N). */
  truncated: boolean;
}

/**
 * Physical line count of a rendered line: the number of `\n`-separated
 * segments it contains (1 when the line carries no embedded newline).
 * The tool result's canonical serialization joins lines with `\n`, so
 * this is the count the client agent actually sees.
 */
function countPhysicalLines(line: string): number {
  let count = 1;
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) === 10 /* '\n' */) count++;
  }
  return count;
}

/**
 * Apply the doc's output caps to a list of rendered lines: emit lines in
 * order while both caps hold, stop at the first line that would trip
 * either, and report truncation. The line cap counts physical lines
 * (embedded newlines included — see the module docs).
 */
export function applyOutputCaps(lines: string[]): OutputCapResult {
  const out: string[] = [];
  let bytes = 0;
  let physicalLines = 0;
  for (const line of lines) {
    const lineCount = countPhysicalLines(line);
    // The '\n' separator is counted between lines (canonical serialization).
    const separatorBytes = out.length > 0 ? 1 : 0;
    const lineBytes = Buffer.byteLength(line, 'utf8') + separatorBytes;
    if (physicalLines + lineCount > OUTPUT_MAX_LINES || bytes + lineBytes > OUTPUT_MAX_BYTES) {
      return { lines: out, truncated: true };
    }
    physicalLines += lineCount;
    bytes += lineBytes;
    out.push(line);
  }
  return { lines: out, truncated: false };
}

/**
 * Apply the doc's caps to a tool result's FINAL text (the wire
 * guarantee — the MCP tool layer caps its assembled result: console
 * output, the result line, pending/checkpoint/completed sections, the
 * wait timeout note, status output, everything). `text` is the
 * canonical serialization (lines joined with `\n`, no trailing
 * newline). When the caps trip, `marker` — a short truncation note —
 * is appended INSTEAD of the dropped tail: the marker's own budget (one
 * physical line plus its bytes) is reserved inside the caps before the
 * content is capped, so the marker always ships and the capped result
 * never exceeds the limits.
 */
export function capFinalText(text: string, marker: string): string {
  const lines = text.split('\n');
  const capped = applyOutputCaps(lines);
  if (!capped.truncated) return text;
  const markerBytes = Buffer.byteLength(marker, 'utf8') + 1; // + the '\n' separator
  const kept: string[] = [];
  let bytes = 0;
  let physicalLines = 0;
  for (const line of lines) {
    const lineCount = countPhysicalLines(line);
    const separatorBytes = kept.length > 0 ? 1 : 0;
    const lineBytes = Buffer.byteLength(line, 'utf8') + separatorBytes;
    if (physicalLines + lineCount > OUTPUT_MAX_LINES - 1 || bytes + lineBytes > OUTPUT_MAX_BYTES - markerBytes) {
      return [...kept, marker].join('\n');
    }
    physicalLines += lineCount;
    bytes += lineBytes;
    kept.push(line);
  }
  return [...kept, marker].join('\n');
}
