// Backend-neutral system prompt instructions (`SystemPromptOptions`): the one validator every
// front door runs BEFORE a session opens — `AcpAgentRunner.prepareSession` (run / interactive /
// reattach), the `AcpAgent` constructor, `agent.fork()`, and the cold statics. The backend maps a
// validated value onto its own `_meta` dialect in `Backend.sessionMeta`; a backend whose
// `Backend.systemPrompt` row does not carry a field never receives it, and the caller learns why
// from a SCRIPT_VALIDATION_ERROR naming the backend, the field, and the escape hatch (`meta`).
import { WorkflowError, WorkflowErrorCode, type SystemPromptOptions } from "@automatalabs/shared-types";
import type { Backend } from "./backend.js";
import { SYSTEM_PROMPT_UNSUPPORTED, type SystemPromptSupport } from "./protocol-coverage.js";

const SYSTEM_PROMPT_FIELDS = ["replace", "append"] as const satisfies readonly (keyof SystemPromptOptions)[];

function validationError(message: string, label: string | undefined): WorkflowError {
  return new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
    recoverable: false,
    agentLabel: label,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Human summary of a support row for error messages: `replace and append`, `append only`, `none`. */
export function describeSystemPromptSupport(support: SystemPromptSupport): string {
  const supported = SYSTEM_PROMPT_FIELDS.filter((field) => support[field]);
  if (supported.length === 0) return "none";
  if (supported.length === SYSTEM_PROMPT_FIELDS.length) return supported.join(" and ");
  return `${supported.join(", ")} only`;
}

/**
 * Validate `systemPrompt` for `backend` and return it normalized (only the defined fields, or
 * undefined when nothing was requested). Throws SCRIPT_VALIDATION_ERROR when the value is not a
 * plain object, a field is not a non-blank string, or the backend does not carry a requested
 * field — an unsupported instruction is refused, never silently ignored.
 */
export function assertSystemPromptSupported(
  backend: Pick<Backend, "id" | "systemPrompt">,
  systemPrompt: SystemPromptOptions | undefined,
  label: string | undefined,
): SystemPromptOptions | undefined {
  if (systemPrompt === undefined) return undefined;
  const prefix = `Agent call${label ? ` "${label}"` : ""}`;
  if (!isRecord(systemPrompt)) {
    throw validationError(`${prefix} systemPrompt must be an object with optional string fields replace / append`, label);
  }
  const unknown = Object.keys(systemPrompt).filter((key) => !(SYSTEM_PROMPT_FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw validationError(
      `${prefix} systemPrompt has unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((key) => `"${key}"`).join(", ")}; only replace / append are accepted (a backend's own extras go through meta)`,
      label,
    );
  }
  const normalized: SystemPromptOptions = {};
  for (const field of SYSTEM_PROMPT_FIELDS) {
    const value = systemPrompt[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      throw validationError(`${prefix} systemPrompt.${field} must be a non-empty string`, label);
    }
    normalized[field] = value;
  }
  const requested = SYSTEM_PROMPT_FIELDS.filter((field) => normalized[field] !== undefined);
  if (requested.length === 0) return undefined;
  const support = backend.systemPrompt ?? SYSTEM_PROMPT_UNSUPPORTED;
  const refused = requested.filter((field) => !support[field]);
  if (refused.length > 0) {
    throw validationError(
      `${prefix} systemPrompt.${refused.join(" / ")} is not supported by backend "${backend.id}" (supported: ${describeSystemPromptSupport(support)}); ` +
        (support.replace || support.append
          ? "use a supported field"
          : "this backend exposes no ACP system-prompt channel — drive its own configuration, or send its vendor `_meta` keys through the meta passthrough"),
      label,
    );
  }
  return normalized;
}
