#!/usr/bin/env node
// Workflow source gate — a Claude Code PreToolUse hook on the `workflow` MCP tool.
//
// WHY (owner directive, 2026-07-16): every bad delivery traced to one seam — the driver's prose
// between the user's request and the workflow's agent prompts. Downstream gates verify against
// the driver's own framing (spec/brief), so a framing error at authoring time is amplified, not
// caught. This gate makes the ORIGINAL request a mechanically-verified input: every workflow
// launch must carry the user's request sentences VERBATIM, and "verbatim" is checked against
// ground truth the driver does not author — the session transcripts, where genuine user turns
// are role-tagged records. A paraphrase, a spec excerpt, a compaction summary, or any other
// agent-authored text cannot pass, because it does not exist as a user-role record.
//
// MECHANICS: Claude Code invokes this on every PreToolUse event matching the workflow tool and
// pipes {session_id, transcript_path, tool_name, tool_input} on stdin. For run actions, the
// launch's args.sourceRequest (string | string[]) must each appear — whitespace-normalized — as
// a substring of a genuine user-authored turn in this project's transcripts (current session
// first, then recent sessions). Genuine means: type:"user", not a tool_result, not isMeta, not
// isCompactSummary (the continuation summary QUOTES user sentences but is agent-authored), not
// isSidechain (subagent prompts are driver-authored), with machine-injected spans
// (<system-reminder>, command wrappers, task notifications) stripped before matching.
//
// Exit 0 = allow. Exit 2 = BLOCK the tool call; stderr is fed back to the model with the most
// recent genuine user turns quoted, so the correction path is "use the user's actual words",
// not "try again". Fails closed: no transcript, no verification, no launch. No bypass env.
//
// The gate checks AUTHENTICITY, not relevance. Choosing the RIGHT sentences — and reconciling
// the workflow's prompts against them (binary questions to the user on any delta) — is the
// launcher's contract: CONTRIBUTING.md "Workflow launches carry the user's verbatim request".

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";

const WORKFLOW_TOOL_SUFFIX = "__workflow";
const MIN_QUOTE_CHARS = 20; // normalized; below this, trivial turns ("ok", "yes") would match
const MAX_CROSS_SESSION_FILES = 100; // newest-first cap for the miss path
const CANDIDATE_TURNS = 8;

function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}

// Remove machine-injected spans from a user turn so quotes can only match what the user typed.
const MACHINE_SPAN_TAGS = [
  "system-reminder",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "command-name",
  "command-message",
  "command-args",
  "task-notification",
];
function stripMachineSpans(text) {
  let out = text;
  for (const tag of MACHINE_SPAN_TAGS) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), " ");
  }
  return out;
}

/** Genuine user prose from one transcript record, or null. */
function userProse(rec) {
  if (rec.type !== "user" || rec.isMeta || rec.isCompactSummary || rec.isSidechain) return null;
  const content = rec.message?.content;
  let text = null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    const parts = content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text);
    if (parts.length > 0) text = parts.join("\n");
  }
  if (text === null) return null;
  const cleaned = normalize(stripMachineSpans(text));
  return cleaned.length > 0 ? cleaned : null;
}

/** Scan one transcript; returns { matched: Set<quoteIndex>, turns: [{ts, text}] (newest last) }. */
function scanTranscript(path, normalizedQuotes, unmatched) {
  const matched = new Set();
  const turns = [];
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { matched, turns };
  }
  for (const line of raw.split("\n")) {
    // Cheap pre-filter: only user records can carry user prose.
    if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const prose = userProse(rec);
    if (prose === null) continue;
    turns.push({ ts: rec.timestamp ?? "", text: prose });
    for (const i of unmatched) {
      if (!matched.has(i) && prose.includes(normalizedQuotes[i])) matched.add(i);
    }
  }
  return { matched, turns };
}

function block(lines) {
  process.stderr.write(lines.join("\n") + "\n");
  process.exit(2);
}

// ---- read the hook payload ----------------------------------------------------------------------
let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  block(["workflow-source-gate: could not parse hook stdin payload — blocking (fails closed)."]);
}

const toolName = payload.tool_name ?? "";
if (!toolName.endsWith(WORKFLOW_TOOL_SUFFIX)) process.exit(0); // defensive; matcher should scope
const toolInput = payload.tool_input ?? {};
const action = toolInput.action ?? "run";
if (action !== "run") process.exit(0); // inspect/await/stop are read-side or lifecycle — not gated

const transcriptPath = payload.transcript_path;
if (!transcriptPath || !existsSync(transcriptPath)) {
  block([
    "workflow-source-gate: no transcript_path in the hook payload — cannot verify the source request; blocking (fails closed).",
  ]);
}

// ---- extract the claimed source ------------------------------------------------------------------
let args = toolInput.args;
if (typeof args === "string") {
  try {
    args = JSON.parse(args);
  } catch {
    args = undefined;
  }
}
const rawSource = args && typeof args === "object" && !Array.isArray(args) ? args.sourceRequest : undefined;
const quotes = (Array.isArray(rawSource) ? rawSource : rawSource !== undefined ? [rawSource] : []).filter(
  (q) => typeof q === "string",
);

const guidance = [
  "",
  "RULE: every workflow run must carry the user's request VERBATIM in args.sourceRequest",
  "(string or string[]). Quote the exact sentence(s) the USER typed that this workflow serves —",
  "never a spec, brief, issue, summary, or any other text you authored. Authenticity is verified",
  "mechanically against the session transcripts (user-role records only), so a paraphrase cannot",
  "pass. If the request came in an earlier session, quote it exactly and the gate will find it.",
  "If the user's words are genuinely not in any transcript (e.g. relayed verbally), STOP and ask",
  "the user to restate the request in chat first.",
  "After the gate passes: reconcile the script's prompts against the quoted source — fix silent",
  "additions/omissions, and put genuine ambiguities to the user as binary questions BEFORE",
  'launching. See CONTRIBUTING.md "Workflow launches carry the user\'s verbatim request".',
];

function candidateLines(turns) {
  const recent = turns.slice(-CANDIDATE_TURNS);
  if (recent.length === 0) return ["(no genuine user turns found in the current session transcript)"];
  return [
    "Most recent genuine user turns in this session (verbatim, truncated) — the request you need",
    "is one of these or lives in an earlier session:",
    ...recent.map((t) => `  [${t.ts}] ${t.text.length > 240 ? t.text.slice(0, 240) + "…" : t.text}`),
  ];
}

const normalizedQuotes = quotes.map(normalize);
const current = scanTranscript(transcriptPath, normalizedQuotes, normalizedQuotes.map((_, i) => i));

if (quotes.length === 0) {
  block([
    "workflow-source-gate: BLOCKED — this workflow run carries no args.sourceRequest.",
    ...guidance,
    "",
    ...candidateLines(current.turns),
  ]);
}

const tooShort = normalizedQuotes.map((q, i) => ({ q, i })).filter(({ q }) => q.length < MIN_QUOTE_CHARS);
if (tooShort.length > 0) {
  block([
    `workflow-source-gate: BLOCKED — sourceRequest entr${tooShort.length === 1 ? "y is" : "ies are"} too short to be a meaningful request quote (min ${MIN_QUOTE_CHARS} normalized chars):`,
    ...tooShort.map(({ q, i }) => `  [${i}] "${q}"`),
    "Quote the user's full request sentence(s), not fragments.",
    ...guidance,
  ]);
}

// ---- verify: current session first, then recent sessions (newest first) --------------------------
const matched = new Set(current.matched);
let unmatched = normalizedQuotes.map((_, i) => i).filter((i) => !matched.has(i));

if (unmatched.length > 0) {
  const dir = dirname(transcriptPath);
  const siblings = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && f !== basename(transcriptPath))
    .map((f) => join(dir, f))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_CROSS_SESSION_FILES);
  for (const { p } of siblings) {
    const res = scanTranscript(p, normalizedQuotes, unmatched);
    for (const i of res.matched) matched.add(i);
    unmatched = unmatched.filter((i) => !matched.has(i));
    if (unmatched.length === 0) break;
  }
}

if (unmatched.length > 0) {
  block([
    "workflow-source-gate: BLOCKED — sourceRequest text was NOT found in any genuine user-authored",
    `turn (searched the current session + the ${MAX_CROSS_SESSION_FILES} most recent sessions). Unverifiable entries:`,
    ...unmatched.map((i) => `  [${i}] "${normalizedQuotes[i].slice(0, 200)}${normalizedQuotes[i].length > 200 ? "…" : ""}"`),
    "",
    "This usually means the text is a PARAPHRASE or an agent-authored artifact (spec/brief/issue/",
    "summary) rather than what the user actually typed. Find the user's original message and quote",
    "it exactly.",
    ...guidance,
    "",
    ...candidateLines(current.turns),
  ]);
}

process.stdout.write(
  `workflow-source-gate: verified ${quotes.length} source quote${quotes.length === 1 ? "" : "s"} against user-authored transcript records.\n`,
);
process.exit(0);
