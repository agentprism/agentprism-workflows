// The codex-acp NEGOTIATED typed-session-failures extension ("AIR"), client side.
//
// WHAT CHANGES WHEN IT IS NEGOTIATED. Without the advertisement, codex-acp reports a terminal turn
// failure the legacy way: `usageLimitExceeded`/auth errors REJECT `session/prompt` with a
// RequestError whose `data.codexErrorInfo` the thrown-error mapper classifies, and every other
// terminal error is appended to the turn as assistant PROSE. With the advertisement accepted, the
// server stops doing both: the turn resolves `end_turn` carrying a sanitized, structured
// `sessionFailure` on `PromptResponse._meta`, and failures it cannot attribute to a running turn
// arrive asynchronously on a `session_info_update`. So a client that advertises the capability MUST
// consume both channels — otherwise a walled turn looks like an empty successful one.
//
// This module owns the wire shape (parse + supersession rules). The failure -> WorkflowError
// classification lives with every other ACP failure mapping in errors-map.ts.
import { CODEX_AIR_EXTENSION_VERSION, CODEX_AIR_META_KEYS } from "@automatalabs/shared-types";

/** The failure categories codex-acp emits today (`SESSION_FAILURE_PRESENTATION` in its
 *  CodexEventHandler). A newer server could add one: an unrecognized category is carried through
 *  verbatim and classified by `retryable` alone, never dropped. */
export type TypedSessionFailureCategory =
  | "transport_lost"
  | "auth_required"
  | "rate_limited"
  | "quota_exhausted"
  | "overloaded"
  | "context_exhausted"
  | "budget_exhausted"
  | "policy_denied"
  | "bad_request"
  | "provider_error"
  | "internal_error";

/** The recovery actions the server suggests for a failure. Advisory: they ride the mapped
 *  WorkflowError's `details` (and its message) so a host can act, but the seam classification is
 *  driven by `category` + `retryable`. */
export type TypedSessionFailureAction = "retry" | "reconnect" | "login" | "new_turn" | "new_session";

/** One typed session failure, exactly as codex-acp puts it on the wire.
 *
 *  IDENTITY + REVISION. `id` is restart-safe: it is derived from the owning turn
 *  (`<turnId>:error`) or, for an unattributed failure, from the session plus the server's process
 *  epoch — so a restarted server never reuses an id. `revision` counts monotonically WITHIN one
 *  `id`; the server bumps it every time it re-records the same failure and once more when it
 *  clears it. A frame for the same `id` at a revision we have already seen is stale and must not
 *  overwrite newer state. */
export interface TypedSessionFailure {
  readonly id: string;
  readonly revision: number;
  /** `active` = the session is in this failed state; `cleared` = the server recovered from it
   *  (a later turn succeeded) and the client must drop the latch. */
  readonly phase: "active" | "cleared";
  readonly category: TypedSessionFailureCategory | (string & {});
  /** The failure's origin as the server names it (`codex` today). */
  readonly source: string;
  /** Server-sanitized, display-safe text. Raw provider prose, stderr, and stack detail are
   *  deliberately withheld from this channel — never expect them here. */
  readonly safeMessage: string;
  /** Whether re-running is meaningful at all. The PRIMARY recoverability signal. */
  readonly retryable: boolean;
  readonly actions: readonly TypedSessionFailureAction[];
  /** The turn this failure belongs to, when the server could attribute it. */
  readonly turnId?: string;
}

/** The `initialize.clientCapabilities._meta` block that turns the extension on. Its shape is
 *  exactly what codex-acp's `clientSupportsTypedSessionFailures` gate parses: an integer `version`
 *  at or above the server's own, and a `capabilities` array containing the session-failure key. */
export const TYPED_SESSION_FAILURE_CLIENT_CAPABILITY: Readonly<Record<string, unknown>> = Object.freeze({
  [CODEX_AIR_META_KEYS.namespace]: Object.freeze({
    [CODEX_AIR_META_KEYS.extension]: Object.freeze({
      [CODEX_AIR_META_KEYS.version]: CODEX_AIR_EXTENSION_VERSION,
      [CODEX_AIR_META_KEYS.capabilities]: Object.freeze([CODEX_AIR_META_KEYS.sessionFailure]),
    }),
  }),
});

const KNOWN_ACTIONS: readonly string[] = ["retry", "reconnect", "login", "new_turn", "new_session"];

/**
 * Read a typed session failure out of any ACP `_meta` (a PromptResponse's or a session update's).
 * Returns undefined for every `_meta` that does not carry one — which is every `_meta` from every
 * other backend, every older codex-acp, and every codex-acp turn that did not fail. Strict and
 * defensive in the house style of `advertisesSteering`/`advertisesLoadedTurn`: a malformed payload
 * is treated as absent rather than half-trusted, so the legacy classification path stays intact.
 *
 * The version bound is `1..CODEX_AIR_EXTENSION_VERSION`: negotiation already guarantees a server
 * never emits a version above the one we advertised, so a higher version means a contract we do
 * not implement and must not guess at.
 */
export function readTypedSessionFailure(meta: unknown): TypedSessionFailure | undefined {
  const extension = record(record(meta)?.[CODEX_AIR_META_KEYS.namespace])?.[CODEX_AIR_META_KEYS.extension];
  const block = record(extension);
  if (!block) return undefined;
  const version = block[CODEX_AIR_META_KEYS.version];
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > CODEX_AIR_EXTENSION_VERSION
  ) {
    return undefined;
  }
  const failure = record(block[CODEX_AIR_META_KEYS.sessionFailure]);
  if (!failure) return undefined;
  const { id, revision, phase, category, source, safeMessage, retryable, actions, turnId } = failure;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof revision !== "number" || !Number.isInteger(revision)) return undefined;
  if (phase !== "active" && phase !== "cleared") return undefined;
  if (typeof category !== "string" || category.length === 0) return undefined;
  if (typeof source !== "string") return undefined;
  if (typeof safeMessage !== "string") return undefined;
  if (typeof retryable !== "boolean") return undefined;
  if (!Array.isArray(actions)) return undefined;
  return Object.freeze({
    id,
    revision,
    phase,
    category,
    source,
    safeMessage,
    retryable,
    // Unknown actions are dropped rather than surfaced as suggestions this client cannot describe.
    actions: Object.freeze(
      actions.filter((action): action is TypedSessionFailureAction =>
        typeof action === "string" && KNOWN_ACTIONS.includes(action),
      ),
    ),
    ...(typeof turnId === "string" ? { turnId } : {}),
  });
}

/**
 * Whether `incoming` is newer than the currently latched `latched` (see the revision/identity notes
 * on TypedSessionFailure). Same id => strictly greater revision wins, so a duplicated or reordered
 * frame can never resurrect a stale state — including a stale `cleared` frame over a newer `active`
 * one. A DIFFERENT id is always newer: the server holds exactly one session failure at a time and
 * only ever mints a fresh id when it replaces the previous record.
 */
export function supersedesTypedSessionFailure(
  latched: TypedSessionFailure | undefined,
  incoming: TypedSessionFailure,
): boolean {
  if (!latched) return true;
  return latched.id === incoming.id ? incoming.revision > latched.revision : true;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
