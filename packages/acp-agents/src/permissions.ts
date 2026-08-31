// toolNames / disallowedToolNames -> ACP session/request_permission auto-responses.
//
// ACP lets a client auto-respond to permission requests without user interaction. The runner's
// headless SDK path still does that from the agentType allow/deny lists. MCP-hosted workflows install
// a resolver instead: unresolved requests remain live until the MCP permission broker returns one of
// the agent's exact advertised optionIds.
//
// The permission option's optionId and order are authoritative. `kind` is used only by the legacy
// headless auto-policy to find an allow/reject polarity; it is never interpreted as a provider
// decision or persistence scope.
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { AcpEventContext } from "./events.js";

/** Async human-in-the-loop decider for ACP permission requests. When present, it handles requests
 * that an explicit ToolPolicy did not already settle. It may resolve arbitrarily later; session
 * teardown still settles the wire request as cancelled, so a dead turn never remains hung. */
export type PermissionResolver = (
  params: RequestPermissionRequest,
  ctx: AcpEventContext,
) => Promise<RequestPermissionResponse> | RequestPermissionResponse;

/** Async human-in-the-loop responder for ACP elicitation/create. ACP marks elicitation
 * UNSTABLE/@experimental; expose the SDK types directly so upgrades catch drift. */
export type ElicitationResolver = (
  request: CreateElicitationRequest,
  context: AcpEventContext,
) => Promise<CreateElicitationResponse> | CreateElicitationResponse;

/** @deprecated Opaque legacy response metadata. It does not select a provider decision or promise
 *  a persistence scope. Choose an exact advertised optionId instead. */
export type PermissionPersist = "session" | "always";

/** @deprecated Coarse compatibility input for resolvePermission. It cannot distinguish multiple
 *  same-kind provider decisions; interactive hosts must select an exact advertised optionId. */
export interface PermissionResolution {
  outcome: "allow" | "deny";
  persist?: PermissionPersist;
}

export interface ToolPolicy {
  /** Allow-list (agentType `tools`). When non-empty, a tool that matches nothing is denied. */
  allow?: string[];
  /** Deny-list (agentType `disallowedTools`), applied after the allow-list. */
  deny?: string[];
  /** No-match fallback for the SDK/headless auto-responder. Default allow. A live resolver handles
   * unmatched requests before this fallback is consulted. */
  defaultOutcome?: "allow" | "deny";
  /** @deprecated Opaque legacy response metadata with no provider-effect guarantee. */
  persist?: PermissionPersist;
}

export type ExplicitToolPolicyDecision = "allow" | "deny";

/** Return the decision imposed by an explicitly authored allow/deny list, or undefined when the
 * request remains unresolved and a live resolver should decide. A deny match always wins; a
 * non-empty allow-list denies nonmatches; a deny-only policy leaves nonmatches unresolved. */
export function decideExplicitToolPolicy(
  request: RequestPermissionRequest,
  policy: ToolPolicy,
): ExplicitToolPolicyDecision | undefined {
  const evaluated = evaluatePolicy(request, policy);
  if (evaluated.denied) return "deny";
  if (evaluated.hasAllowList) return evaluated.allowedByList ? "allow" : "deny";
  return undefined;
}

/** Decide the SDK/headless auto-response for one permission request. */
export function decidePermission(
  request: RequestPermissionRequest,
  policy: ToolPolicy,
): RequestPermissionResponse {
  const evaluated = evaluatePolicy(request, policy);
  const defaultOutcome = policy.defaultOutcome ?? "allow";
  const allowed = evaluated.hasAllowList ? evaluated.allowedByList : defaultOutcome === "allow";
  const wantAllow = !evaluated.denied && allowed;
  const response = responseForPolarity(request, wantAllow);
  return wantAllow ? withPersist(response, policy.persist) : response;
}

/** Build a response for an exact option advertised by this request. An unknown/stale option fails
 * closed as cancelled. No label, kind, or metadata is interpreted. */
export function selectPermissionOption(
  request: RequestPermissionRequest,
  optionId: string,
): RequestPermissionResponse {
  return request.options.some((option) => option.optionId === optionId)
    ? { outcome: { outcome: "selected", optionId } }
    : { outcome: { outcome: "cancelled" } };
}

/** @deprecated Stamps opaque legacy metadata only. Current first-class backends derive effects from
 *  the selected advertised optionId and may ignore this field entirely. */
export function withPersist(
  response: RequestPermissionResponse,
  persist: PermissionPersist | undefined,
): RequestPermissionResponse {
  if (!persist || response.outcome.outcome !== "selected") return response;
  return { ...response, _meta: { ...(response._meta ?? {}), persist } };
}

/** @deprecated Coarse polarity selection retained for source compatibility. It preserves the old
 *  response shape but cannot promise a scope or distinguish same-kind decisions. */
export function resolvePermission(
  request: RequestPermissionRequest,
  resolution: PermissionResolution,
): RequestPermissionResponse {
  const wantAllow = resolution.outcome === "allow";
  const response = responseForPolarity(request, wantAllow);
  return wantAllow ? withPersist(response, resolution.persist) : response;
}

interface EvaluatedPolicy {
  denied: boolean;
  allowedByList: boolean;
  hasAllowList: boolean;
}

function evaluatePolicy(request: RequestPermissionRequest, policy: ToolPolicy): EvaluatedPolicy {
  const { toolNames, decoration } = candidateNames(request);
  // Prefer an authoritative vendor toolName when present; title/kind remain a compatibility
  // fallback for agents that do not expose one.
  const exactPool = toolNames.length > 0 ? toolNames : decoration;
  const allPool = [...toolNames, ...decoration];

  const denyList = policy.deny ?? [];
  const allowList = policy.allow ?? [];
  const hasDeny = denyList.length > 0;
  const hasAllowList = allowList.length > 0;

  const denyExact = hasDeny && exactMatchesAny(exactPool, denyList);
  const allowExact = hasAllowList && exactMatchesAny(exactPool, allowList);

  if (denyExact || allowExact) {
    return {
      denied: denyExact,
      allowedByList: allowExact,
      hasAllowList,
    };
  }

  return {
    denied: hasDeny && substringMatchesAny(allPool, denyList),
    allowedByList: hasAllowList && substringMatchesAny(allPool, allowList),
    hasAllowList,
  };
}

interface CandidateNames {
  toolNames: string[];
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

function exactMatchesAny(names: string[], patterns: string[]): boolean {
  const lowered = new Set(names.map((name) => name.toLowerCase()).filter(Boolean));
  return patterns.some((pattern) => {
    const normalized = pattern.toLowerCase();
    return normalized.length > 0 && lowered.has(normalized);
  });
}

function substringMatchesAny(names: string[], patterns: string[]): boolean {
  const lowered = names.map((name) => name.toLowerCase()).filter(Boolean);
  return patterns.some((pattern) => {
    const normalized = pattern.toLowerCase();
    if (!normalized) return false;
    return lowered.some((name) =>
      name === normalized || name.includes(normalized) || normalized.includes(name)
    );
  });
}

const ALLOW_KIND_ORDER: PermissionOptionKind[] = ["allow_once", "allow_always"];
const REJECT_KIND_ORDER: PermissionOptionKind[] = ["reject_once", "reject_always"];

function responseForPolarity(
  request: RequestPermissionRequest,
  wantAllow: boolean,
): RequestPermissionResponse {
  const option = pickOption(request.options, wantAllow);
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function pickOption(options: PermissionOption[], wantAllow: boolean): PermissionOption | undefined {
  const order = wantAllow ? ALLOW_KIND_ORDER : REJECT_KIND_ORDER;
  for (const kind of order) {
    const found = options.find((option) => option.kind === kind);
    if (found) return found;
  }
  return undefined;
}
