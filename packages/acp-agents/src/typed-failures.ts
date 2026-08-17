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

/** The failure categories codex-acp emits today (`SESSION_FAILURE_POLICY` in its
 *  CodexEventHandler). The vocabulary is coarse — the finer per-error distinctions the server used
 *  to expose as categories now ride `actions` (see the mapper). A newer server could add a
 *  category: an unrecognized one is carried through verbatim and classified by its `actions`
 *  alone, never dropped. */
export type TypedSessionFailureCategory =
  | "connection"
  | "access"
  | "limit"
  | "request"
  | "service"
  | "unknown";

/** How loudly the client should render the record. Absent on the wire means `error`, so a build
 *  that predates warning support keeps treating every record it receives as a failure. `warning`
 *  records are advisory (retry hints, deprecation notices) and never fail a turn. */
export type TypedSessionFailureSeverity = "error" | "warning";

/** The recovery actions the server suggests for a failure. Advisory to a host — they ride the
 *  mapped WorkflowError's `details` (and its message) — but they are ALSO the finest recoverability
 *  signal the wire still carries now that `retryable` is gone: the mapper reads `retry` (this
 *  category is worth re-running) and `new_session` (a ceiling that a resume cannot clear). */
export type TypedSessionFailureAction = "retry" | "login" | "new_session";

/** One typed session failure, exactly as codex-acp puts it on the wire.
 *
 *  IDENTITY + REVISION. `id` is restart-safe: it is derived from the owning turn
 *  (`<turnId>:error`) or, for an unattributed failure, from the session plus the server's process
 *  epoch — so a restarted server never reuses an id. `revision` counts monotonically WITHIN one
 *  `id`; records sharing an id form one logical banner whose revision increases each time the
 *  server re-records the same failure. A frame for the same `id` at a revision we have already seen
 *  is stale and must not overwrite newer state. There is no explicit "cleared" record anymore: the
 *  server retires a failure by simply not re-publishing it, and a later successful turn is what
 *  proves recovery. */
export interface TypedSessionFailure {
  readonly id: string;
  readonly revision: number;
  readonly category: TypedSessionFailureCategory | (string & {});
  /** Render loudness. `error` is a real failure; `warning` is advisory and never fails a turn.
   *  Absent on the wire is normalized to `error` per the server's forward-compatibility rule. */
  readonly severity: TypedSessionFailureSeverity;
  /** Server-sanitized, display-safe summary. Raw provider prose, stderr, and stack detail are
   *  deliberately withheld from this channel — never expect them here. */
  readonly title: string;
  /** Optional supplementary display-safe text (present on advisory notices that split a long
   *  summary into a title plus details). */
  readonly details?: string;
  readonly actions: readonly TypedSessionFailureAction[];
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

const KNOWN_ACTIONS: readonly string[] = ["retry", "login", "new_session"];

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
  const { id, revision, category, severity, title, details, actions } = failure;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof revision !== "number" || !Number.isInteger(revision)) return undefined;
  if (typeof category !== "string" || category.length === 0) return undefined;
  if (typeof title !== "string") return undefined;
  if (!Array.isArray(actions)) return undefined;
  if (details !== undefined && typeof details !== "string") return undefined;
  return Object.freeze({
    id,
    revision,
    category,
    // `warning` is the only non-error severity; anything else — absent, "error", or a value we do
    // not recognize — normalizes to "error" so a real failure is never silently downgraded.
    severity: severity === "warning" ? "warning" : "error",
    title,
    ...(typeof details === "string" ? { details } : {}),
    // Unknown actions are dropped rather than surfaced as suggestions this client cannot describe.
    actions: Object.freeze(
      actions.filter((action): action is TypedSessionFailureAction =>
        typeof action === "string" && KNOWN_ACTIONS.includes(action),
      ),
    ),
  });
}

/**
 * Whether `incoming` is newer than the currently latched `latched` (see the revision/identity notes
 * on TypedSessionFailure). Same id => strictly greater revision wins, so a duplicated or reordered
 * frame can never resurrect a stale state or roll a record back to an older category. A DIFFERENT
 * id is always newer: the server holds exactly one active failure at a time and only ever mints a
 * fresh id when it replaces the previous record.
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
