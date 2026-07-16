import { RequestError } from "@agentclientprotocol/sdk";

export type ErrorKind =
  | "auth_error"
  | "rate_limit"
  | "billing_error"
  | "provider_error"
  | "invalid_model"
  | "empty_prompt"
  | "session_busy"
  | "invalid_config_value"
  | "invalid_config_type"
  | "unknown_config_option"
  | "invalid_cwd"
  | "unknown_session"
  | "session_already_open"
  | "session_terminated"
  | "session_corrupt"
  | "session_not_forkable"
  | "mcp_init_error"
  | "unsupported_mcp_transport"
  | "structured_tool_collision"
  | "invalid_output_schema"
  | "invalid_cursor"
  | "unknown_auth_method"
  | "notification_error"
  | "internal_error";

const LABELS: Record<ErrorKind, string> = {
  auth_error: "provider credentials required",
  rate_limit: "provider rate limit",
  billing_error: "provider billing or quota wall",
  provider_error: "provider error",
  invalid_model: "unknown or unselectable model",
  empty_prompt: "prompt has no text or images",
  session_busy: "session has a turn in flight",
  invalid_config_value: "invalid config option",
  invalid_config_type: "invalid config option",
  unknown_config_option: "invalid config option",
  invalid_cwd: "invalid working directory",
  unknown_session: "unknown session id",
  session_already_open: "session already open",
  session_terminated: "session terminated",
  session_corrupt: "session file could not be read",
  session_not_forkable: "session has no persisted history to fork",
  mcp_init_error: "mcp server initialization failed",
  unsupported_mcp_transport: "unsupported mcp transport",
  structured_tool_collision: "structured-output tool unavailable",
  invalid_output_schema: "invalid output schema",
  invalid_cursor: "invalid list cursor",
  unknown_auth_method: "unknown auth method",
  notification_error: "notification delivery failed",
  internal_error: "internal error",
};

const INVALID_KINDS = new Set<ErrorKind>([
  "invalid_model",
  "empty_prompt",
  "session_busy",
  "invalid_config_value",
  "invalid_config_type",
  "unknown_config_option",
  "invalid_cwd",
  "unknown_session",
  "session_already_open",
  "session_terminated",
  "session_not_forkable",
  "unsupported_mcp_transport",
  "invalid_output_schema",
  "invalid_cursor",
  "unknown_auth_method",
]);

export interface DiagnosticLike {
  type: string;
  timestamp: number;
  error?: { name?: string; message: string; stack?: string; code?: string | number };
  details?: unknown;
}

export interface TerminalAssistantLike {
  stopReason: string;
  errorMessage?: string;
  diagnostics?: DiagnosticLike[];
}

export function redactedDiagnostics(diagnostics: readonly DiagnosticLike[] | undefined) {
  return diagnostics?.length
    ? diagnostics.map(({ type, timestamp }) => ({ type, timestamp }))
    : undefined;
}

export function adapterError(
  kind: ErrorKind,
  extras: { server?: string; details?: Array<{ type: string; timestamp: number }> } = {},
): RequestError {
  const data: Record<string, unknown> = { errorKind: kind, message: LABELS[kind] };
  if (extras.server !== undefined) data.server = extras.server;
  if (extras.details !== undefined) data.details = extras.details;
  if (kind === "auth_error") return RequestError.authRequired(data);
  if (INVALID_KINDS.has(kind)) return RequestError.invalidParams(data);
  return RequestError.internalError(data);
}

export function classifyPreflight(error: unknown): RequestError {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("no model selected")) return adapterError("invalid_model");
  if (
    message.includes("no api key found") ||
    message.includes("authentication failed for") ||
    message.includes("run '/login")
  ) {
    return adapterError("auth_error");
  }
  return adapterError("provider_error");
}

export function classifyTerminal(message: TerminalAssistantLike): RequestError {
  const diagnostics = message.diagnostics ?? [];
  const haystack = [
    message.errorMessage ?? "",
    ...diagnostics.flatMap((item) => [
      item.type,
      item.error?.name ?? "",
      item.error?.message ?? "",
    ]),
  ]
    .join("\n")
    .toLowerCase();
  if (/\b401\b|\b403\b|unauthorized|invalid api key|authentication|forbidden|expired/.test(haystack)) {
    return adapterError("auth_error");
  }
  if (/quota|billing|insufficient|payment|credit|exceeded your/.test(haystack)) {
    return adapterError("billing_error");
  }
  if (/\b429\b|rate limit|too many requests|overloaded/.test(haystack)) {
    return adapterError("rate_limit");
  }
  return adapterError("provider_error", { details: redactedDiagnostics(diagnostics) });
}

export function unexpectedError(error: unknown, terminal?: TerminalAssistantLike): RequestError {
  console.error("pi-acp internal error:", error);
  return adapterError("internal_error", {
    details: redactedDiagnostics(terminal?.diagnostics),
  });
}

export function isRequestError(error: unknown): error is RequestError {
  return error instanceof RequestError;
}
