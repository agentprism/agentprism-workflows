// toolNames / disallowedToolNames -> ACP session/request_permission auto-responses.
//
// ACP lets a client auto-respond to permission requests without user interaction
// (§5.5). The runner is headless, so we DECIDE allow/deny at that boundary from the
// agentType's allow-list (toolNames) and deny-list (disallowedToolNames). The ACP
// permission request does not carry a first-class tool NAME, so we match best-effort
// against the request's title, kind, and any vendor `_meta.*.toolName` (Claude stamps it).
// Default is ALLOW so a headless subagent can do real work; a matched deny-rule, or a
// non-empty allow-list with no match, rejects. When the host explicitly requests an ACP
// session mode and no human resolver is present, the runner flips the no-match default to
// DENY so a sandboxed mode cannot be defeated by auto-approving escalations.
//
// MATCH PRECEDENCE LADDER (tightened from the old bidirectional substring, which both
// silently over-allowed — 'read' ⊂ 'thread-reader' — and ignored the authoritative tool
// id when matching a human title):
//   (a) EXACT (case-insensitive): prefer the authoritative tool identity — the vendor
//       `_meta.*.toolName` when present, else the title/kind. If ANY policy entry exactly
//       equals such a candidate, the tool is PRECISELY identified and we decide on exact
//       matches ALONE, suppressing loose substring matches entirely. This is what stops a
//       deny `read` from also catching an exactly-allowed `thread-reader` tool.
//   (b) SUBSTRING fallback: only when NO policy entry exactly matches the request do we
//       fall back to the prior best-effort bidirectional substring over all candidates.
// RESIDUAL AMBIGUITY (deliberately kept for back-compat / unnamed-tool cases): absent any
// exact entry, a short pattern can still substring-match an unrelated longer name (e.g.
// `read` still matches `thread-reader`, and `read` still matches `ReadFileTool`). The
// exact tier removes this only once a precise name pins the tool.
import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { AcpEventContext } from "./events.js";

/** Async human-in-the-loop decider for ACP permission requests. When present, it REPLACES the
 *  synchronous ToolPolicy path for the sessions it applies to: the agent turn parks until this
 *  resolver selects an ACP permission outcome. It may resolve arbitrarily later (seconds or
 *  minutes); the library guarantees every parked request is settled with the ACP
 *  `{ outcome: { outcome: "cancelled" } }` response when its session is released, its turn is
 *  cancelled via session/cancel, or its connection dies, so teardown can never leave an agent
 *  turn hung behind an unanswered permission prompt. */
export type PermissionResolver = (
  params: RequestPermissionRequest,
  ctx: AcpEventContext,
) => Promise<RequestPermissionResponse> | RequestPermissionResponse;

export interface ToolPolicy {
  /** Allow-list (agentType `tools`). When non-empty, a tool that matches NOTHING is denied. */
  allow?: string[];
  /** Deny-list (agentType `disallowedTools`), applied after the allow-list. */
  deny?: string[];
  /** No-match fallback for the headless auto-responder. Default "allow" preserves historical
   *  behavior. Explicit ACP session modes set this to "deny" unless a permission resolver is
   *  present, otherwise read-only/plan confinement can be bypassed by auto-approved escalations. */
  defaultOutcome?: "allow" | "deny";
}

const ALLOW_KIND_ORDER: PermissionOptionKind[] = ["allow_once", "allow_always"];
const REJECT_KIND_ORDER: PermissionOptionKind[] = ["reject_once", "reject_always"];

/** Decide the auto-response for one permission request given the tool policy. */
export function decidePermission(
  request: RequestPermissionRequest,
  policy: ToolPolicy,
): RequestPermissionResponse {
  const { toolNames, decoration } = candidateNames(request);
  // (a) EXACT pool: the authoritative tool id (vendor _meta.toolName) when present, else
  //     the human title/kind. The substring pool is everything, used only as a fallback.
  const exactPool = toolNames.length > 0 ? toolNames : decoration;
  const allPool = [...toolNames, ...decoration];

  const denyList = policy.deny ?? [];
  const allowList = policy.allow ?? [];
  const defaultOutcome = policy.defaultOutcome ?? "allow";
  const hasDeny = denyList.length > 0;
  const hasAllowList = allowList.length > 0;

  const denyExact = hasDeny && exactMatchesAny(exactPool, denyList);
  const allowExact = hasAllowList && exactMatchesAny(exactPool, allowList);

  let denied: boolean;
  let allowedByList: boolean;
  if (denyExact || allowExact) {
    // The tool is EXACTLY named by some policy entry -> decide on exact matches alone.
    // (Suppresses loose substring matches: a deny `read` no longer catches an exactly
    // allow-listed `thread-reader`.)
    denied = denyExact;
    allowedByList = hasAllowList ? allowExact : defaultOutcome === "allow";
  } else {
    // (b) No exact match in either list -> best-effort bidirectional substring fallback.
    denied = hasDeny && substringMatchesAny(allPool, denyList);
    allowedByList = hasAllowList ? substringMatchesAny(allPool, allowList) : defaultOutcome === "allow";
  }
  const wantAllow = !denied && allowedByList;

  const option = pickOption(request.options, wantAllow);
  if (!option) {
    // No option of the desired polarity exists. Cancelling the permission is the only
    // remaining way to refuse a tool the server offers no reject option for.
    return { outcome: { outcome: "cancelled" } };
  }
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

interface CandidateNames {
  /** Authoritative tool identities pulled from vendor `_meta.*.toolName` (Claude stamps it). */
  toolNames: string[];
  /** Human-readable decoration: the request title and kind. */
  decoration: string[];
}

function candidateNames(request: RequestPermissionRequest): CandidateNames {
  const decoration: string[] = [];
  const toolCall = request.toolCall;
  if (toolCall.title) decoration.push(toolCall.title);
  if (toolCall.kind) decoration.push(toolCall.kind);
  const toolNames: string[] = [];
  collectMetaToolNames(toolCall._meta, toolNames);
  return { toolNames, decoration };
}

function collectMetaToolNames(meta: unknown, out: string[]): void {
  if (!meta || typeof meta !== "object") return;
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (key === "toolName" && typeof value === "string") out.push(value);
    else if (value && typeof value === "object") collectMetaToolNames(value, out);
  }
}

/** (a) Does any pattern EXACTLY equal (case-insensitive) any candidate name? */
function exactMatchesAny(names: string[], patterns: string[]): boolean {
  const lowered = new Set(names.map((n) => n.toLowerCase()).filter(Boolean));
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.length > 0 && lowered.has(p);
  });
}

/** (b) Best-effort bidirectional substring fallback (the prior, looser semantics). */
function substringMatchesAny(names: string[], patterns: string[]): boolean {
  const lowered = names.map((n) => n.toLowerCase()).filter(Boolean);
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    if (!p) return false;
    return lowered.some((n) => n === p || n.includes(p) || p.includes(n));
  });
}

function pickOption(options: PermissionOption[], wantAllow: boolean): PermissionOption | undefined {
  const order = wantAllow ? ALLOW_KIND_ORDER : REJECT_KIND_ORDER;
  for (const kind of order) {
    const found = options.find((option) => option.kind === kind);
    if (found) return found;
  }
  return undefined;
}
