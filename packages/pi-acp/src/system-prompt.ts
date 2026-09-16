// The `_meta.systemPrompt` session channel: the backend-neutral system-prompt instructions an ACP
// client sends on `session/new`, `session/resume`, `session/load`, and `session/fork`, folded into
// pi's own `DefaultResourceLoader` overrides. `replace` becomes pi's custom system prompt (the
// same slot as a SYSTEM.md / `--system-prompt`); `append` becomes one more append-system-prompt
// entry after the operator's configured ones. Advertised at initialize under
// `_meta.systemPrompt` so a client can check support before sending. Mirrored (not imported) by
// `@automatalabs/shared-types` `META_KEYS.systemPrompt` / `PiSystemPromptMeta`.
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { adapterError } from "./errors.js";

/** pi does not export its loader options type; derive it from the constructor. */
type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** The bare session `_meta` key (the same key claude-agent-acp reads, so clients that switch
 *  between the two servers keep one wire shape). */
export const SYSTEM_PROMPT_META_KEY = "systemPrompt";

/** What the server advertises under `InitializeResponse._meta.systemPrompt`. */
export const SYSTEM_PROMPT_ADVERTISEMENT = Object.freeze({ replace: true, append: true });

export interface SystemPromptOverrides {
  /** Replaces pi's built-in system prompt (pi's custom-prompt slot). */
  replace?: string;
  /** Appended after pi's built-in (or replaced) prompt and the operator's append entries. */
  append?: string;
}

const FIELDS = ["replace", "append"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw adapterError("invalid_system_prompt", { field });
  }
  return value;
}

/**
 * Read `_meta.systemPrompt` off a session request. A string replaces the prompt; an object carries
 * `replace` and/or `append`. Returns undefined when the key is absent or asks for nothing, and
 * rejects malformed values with `invalid_system_prompt` (`-32602`) BEFORE any session state is
 * created — an unusable instruction must fail loudly, never run under the default prompt.
 */
export function readSystemPromptMeta(meta: unknown): SystemPromptOverrides | undefined {
  if (!isRecord(meta)) return undefined;
  const value = meta[SYSTEM_PROMPT_META_KEY];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return { replace: nonBlankString(value, "replace") };
  if (!isRecord(value)) throw adapterError("invalid_system_prompt", { field: SYSTEM_PROMPT_META_KEY });
  const unknown = Object.keys(value).find((key) => !(FIELDS as readonly string[]).includes(key));
  if (unknown !== undefined) throw adapterError("invalid_system_prompt", { field: unknown });
  const overrides: SystemPromptOverrides = {};
  for (const field of FIELDS) {
    if (value[field] === undefined) continue;
    overrides[field] = nonBlankString(value[field], field);
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/** The `DefaultResourceLoader` override hooks that realize the instructions; empty when none. */
export function systemPromptLoaderOverrides(
  overrides: SystemPromptOverrides | undefined,
): Pick<DefaultResourceLoaderOptions, "systemPromptOverride" | "appendSystemPromptOverride"> {
  if (!overrides) return {};
  const { replace, append } = overrides;
  return {
    ...(replace !== undefined ? { systemPromptOverride: () => replace } : {}),
    ...(append !== undefined ? { appendSystemPromptOverride: (base: string[]) => [...base, append] } : {}),
  };
}
