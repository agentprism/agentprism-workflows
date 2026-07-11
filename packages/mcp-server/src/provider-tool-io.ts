// packages/mcp-server/src/provider-tool-io.ts
//
// Zod I/O shapes + pure projections for the three MCP provider tools, mirroring
// auth-tool-io.ts. These tools sit alongside `workflow` and share the injected
// provider-capable runner. The `providers/*` surface is GENERIC base-spec ACP: every backend
// that advertises the unstable `agentCapabilities.providers` block is served identically —
// there is no agent-specific branch anywhere in these tools.
//
// SECRETS DISCIPLINE (Principle 9): the `headers` input to workflow_set_provider is credential
// material (gateway Authorization headers). It is handed straight to `runner.setProvider`;
// NOTHING here echoes it into a tool output, a content block, or a log. The list projection is
// symmetric: only `providerId` / `supported` / `required` / `current { apiType, baseUrl }`
// survive — agents keep headers out of `current` by contract, and any `_meta` (which a
// non-conformant agent could stuff anything into) is dropped client-side too.
import { z } from "zod";
import type { ProviderInfo } from "@automatalabs/workflows";

// ── Tool 1: workflow_providers (read-only; no secrets in or out) ──

export const providersInputShape = {
  backend: z
    .string()
    .optional()
    .describe("Backend id/name to scope to (claude | codex | opencode | a custom backend name). Omit for all."),
} as const;

export const providersOutputShape = {
  backends: z.array(
    z.object({
      backendId: z.string(),
      // false when the backend does not advertise `agentCapabilities.providers` (or could not be
      // probed) — the read-only tool reports that instead of hard-failing the whole call.
      providersSupported: z.boolean(),
      providers: z.array(
        z.object({
          providerId: z.string(),
          supported: z.array(z.string()),
          required: z.boolean(),
          // Non-secret routing only (apiType + baseUrl); null when not configured/disabled.
          current: z
            .object({ apiType: z.string(), baseUrl: z.string() })
            .nullable(),
        }),
      ),
    }),
  ),
} as const;

/** One provider as projected onto the tool output — non-secret routing only. */
export interface ProvidersToolProvider {
  providerId: string;
  supported: string[];
  required: boolean;
  current: { apiType: string; baseUrl: string } | null;
}

/** One backend as projected onto the tool output. */
export interface ProvidersToolBackend {
  backendId: string;
  providersSupported: boolean;
  providers: ProvidersToolProvider[];
}

export interface ProvidersToolResult {
  backends: ProvidersToolBackend[];
}

/**
 * Project one agent-reported `ProviderInfo` onto the redacted tool provider. Field-by-field so
 * `_meta` (top-level and inside `current`) never leaks; `current` collapses to its two non-secret
 * routing fields or null.
 */
export function projectProviderInfo(info: ProviderInfo): ProvidersToolProvider {
  return {
    providerId: info.providerId,
    supported: [...info.supported],
    required: info.required,
    current: info.current ? { apiType: info.current.apiType, baseUrl: info.current.baseUrl } : null,
  };
}

// ── Tools 2+3: workflow_set_provider (action; `headers` is SECRET and never echoed) and
//    workflow_disable_provider (action; no secrets) ──

export const setProviderInputShape = {
  backend: z.string().describe("Backend id/name (claude | codex | opencode | custom)."),
  providerId: z.string().describe("A providerId from workflow_providers."),
  apiType: z
    .string()
    .describe("Provider protocol from that provider's `supported` list (e.g. \"openai\", \"anthropic\")."),
  baseUrl: z.string().describe("Gateway base URL the backend should route this provider through."),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("SECRET HTTP headers (e.g. Authorization). Never echoed, journaled, or logged."),
} as const;

export const setProviderOutputShape = {
  backend: z.string(),
  providerId: z.string(),
  status: z.literal("configured"),
} as const;

export const disableProviderInputShape = {
  backend: z.string().describe("Backend id/name (claude | codex | opencode | custom)."),
  providerId: z.string().describe("The providerId to disable (idempotent per the providers RFD)."),
} as const;

export const disableProviderOutputShape = {
  backend: z.string(),
  providerId: z.string(),
  status: z.literal("disabled"),
} as const;

export interface SetProviderToolResult {
  backend: string;
  providerId: string;
  status: "configured";
}

export interface DisableProviderToolResult {
  backend: string;
  providerId: string;
  status: "disabled";
}

/** Human-readable summary for a workflow_providers call — backend ids, support flags, and the
 *  redacted provider rows only (the projection carries nothing else). */
export function formatProvidersSummary(backends: ProvidersToolBackend[]): string {
  if (backends.length === 0) return "No backends are registered.";
  const lines: string[] = [];
  for (const b of backends) {
    if (!b.providersSupported) {
      lines.push(`backend "${b.backendId}": providers not supported (no agentCapabilities.providers advertisement, or the backend could not be probed)`);
      continue;
    }
    lines.push(`backend "${b.backendId}": ${b.providers.length} configurable provider${b.providers.length === 1 ? "" : "s"}`);
    for (const p of b.providers) {
      const current = p.current ? `current: ${p.current.apiType} @ ${p.current.baseUrl}` : "not configured";
      lines.push(`  - ${p.providerId} (protocols: ${p.supported.join(", ") || "none"}${p.required ? "; required" : ""}) — ${current}`);
    }
  }
  return lines.join("\n");
}

/** Human-readable summary for a completed workflow_set_provider call, built ONLY from the
 *  non-secret `{ backend, providerId }` echo — never from `headers`. */
export function formatSetProviderSummary(result: SetProviderToolResult): string {
  return `Provider "${result.providerId}" configured on backend "${result.backend}". New sessions route through it; call workflow_providers to inspect the non-secret routing.`;
}

/** Human-readable summary for a completed workflow_disable_provider call. */
export function formatDisableProviderSummary(result: DisableProviderToolResult): string {
  return `Provider "${result.providerId}" disabled on backend "${result.backend}".`;
}
