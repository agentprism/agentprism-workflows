// packages/mcp-server/src/auth-tool-io.ts
//
// Zod I/O shapes + pure projections for the two MCP auth tools (§4.3), mirroring
// workflow-tool-input.ts / workflow-tool-output.ts. These tools sit alongside the single
// `workflow` tool and share the injected auth-capable runner.
//
// SECRETS DISCIPLINE (Principle 9): the `env`/`meta` inputs to workflow_authenticate are
// credential material. They are mapped straight into an `AuthResolution` and handed to
// `runner.completeAuth`; NOTHING here echoes them into a tool output, a content block, or a
// log. Both output projections carry only redacted, non-secret fields — ids / types / names /
// labels / flags / state — never a value.
import { z } from "zod";
import type { AuthMethodDescriptor, AuthResolution, AuthStatusSnapshot } from "@automatalabs/workflows";

// ── Tool 1: workflow_auth_status (read-only; no secrets in or out) ──

export const authStatusInputShape = {
  backend: z
    .string()
    .optional()
    .describe("Backend id/name to scope to (claude | codex | opencode | a custom backend name). Omit for all."),
} as const;

export const authStatusOutputShape = {
  backends: z.array(
    z.object({
      backendId: z.string(),
      state: z.enum(["unauthenticated", "credentials_held", "authenticated", "auth_required"]),
      authenticated: z.boolean(),
      canResume: z.boolean(),
      methods: z.array(
        z.object({
          id: z.string(),
          type: z.enum(["agent", "terminal", "env_var"]),
          name: z.string().optional(),
          description: z.string().optional(),
          // true for a bare `agent` method that needs a browser/TTY to complete (§1.3). A headless
          // host uses this to skip the method rather than calling workflow_authenticate on it.
          interactive: z.boolean().optional(),
          // env_var only: which vars to collect. NAMES/LABELS/flags only — never any value.
          vars: z
            .array(
              z.object({
                name: z.string(),
                label: z.string().optional(),
                secret: z.boolean(),
                optional: z.boolean(),
              }),
            )
            .optional(),
          link: z.string().optional(),
        }),
      ),
    }),
  ),
} as const;

/** One redacted method as projected onto the tool output. */
export interface AuthStatusToolMethod {
  id: string;
  type: "agent" | "terminal" | "env_var";
  name?: string;
  description?: string;
  interactive?: boolean;
  vars?: Array<{ name: string; label?: string; secret: boolean; optional: boolean }>;
  link?: string;
}

/** One backend as projected onto the tool output. */
export interface AuthStatusToolBackend {
  backendId: string;
  state: AuthStatusSnapshot["state"];
  authenticated: boolean;
  canResume: boolean;
  methods: AuthStatusToolMethod[];
}

export interface AuthStatusToolResult {
  backends: AuthStatusToolBackend[];
}

/**
 * Project one dispatched `AuthMethodDescriptor` (§1.3) onto the redacted tool method. This is a
 * NON-SECRET view: the descriptor's `meta` and `launch` (which may carry command hints) are
 * dropped, and env_var `vars` are copied field-by-field so per-var `meta` never leaks — only
 * name/label/secret/optional survive.
 */
export function projectAuthMethod(descriptor: AuthMethodDescriptor): AuthStatusToolMethod {
  const base: AuthStatusToolMethod = { id: descriptor.id, type: descriptor.type, name: descriptor.name };
  if (descriptor.description !== undefined) base.description = descriptor.description;
  if (descriptor.type === "agent") {
    base.interactive = descriptor.interactive;
  } else if (descriptor.type === "env_var") {
    base.vars = descriptor.vars.map((v) => ({
      name: v.name,
      ...(v.label !== undefined ? { label: v.label } : {}),
      secret: v.secret,
      optional: v.optional,
    }));
    if (descriptor.link !== undefined) base.link = descriptor.link;
  }
  return base;
}

/**
 * Merge a backend's dispatched descriptors (from `describeAuthMethods`) with its redacted
 * `AuthStatusSnapshot` (from `runner.auth.status`) into one tool backend. `state`/`authenticated`/
 * `canResume` come from the snapshot; the rich `methods` come from the descriptors. When the
 * snapshot is absent (a backend that could not be probed), the state degrades to "unauthenticated".
 */
export function projectAuthStatusBackend(
  backendId: string,
  descriptors: AuthMethodDescriptor[],
  snapshot: AuthStatusSnapshot | undefined,
): AuthStatusToolBackend {
  return {
    backendId,
    state: snapshot?.state ?? "unauthenticated",
    authenticated: snapshot?.authenticated ?? false,
    canResume: snapshot?.canResume ?? false,
    methods: descriptors.map(projectAuthMethod),
  };
}

// ── Tool 2: workflow_authenticate (action; `env`/`meta` are SECRET and never echoed) ──

export const authenticateInputShape = {
  backend: z.string().describe("Backend id/name (claude | codex | opencode | custom)."),
  methodId: z.string().describe("A method id from workflow_auth_status."),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("SECRET env_var values keyed by var name (for env_var methods). Never echoed, journaled, or logged."),
  meta: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("SECRET agent-type _meta payload (e.g. gateway { baseUrl, headers }). Never echoed, journaled, or logged."),
} as const;

export const authenticateOutputShape = {
  status: z.enum(["authenticated", "cancelled"]),
  methodId: z.string(),
  recycled: z.boolean(),
} as const;

export interface AuthenticateToolResult {
  status: "authenticated" | "cancelled";
  methodId: string;
  recycled: boolean;
}

/** A descriptor is interactive (needs a browser/TTY the MCP host lacks) iff it is a bare `agent`
 *  method that runs its own login (§1.3). Everything else — terminal, env_var, gateway/api-key
 *  agent — is completable headlessly given its out-of-band credential. */
function isInteractive(descriptor: AuthMethodDescriptor): boolean {
  return descriptor.type === "agent" && descriptor.interactive;
}

/** The result of mapping a workflow_authenticate input onto an `AuthResolution`. Either a resolution
 *  to hand to `completeAuth`, or a `cancelled` short-circuit with a host-facing explanation for a
 *  method the MCP host cannot complete (interactive bare-`agent`, or an unknown method id). */
export type AuthenticateMapping =
  | { kind: "resolve"; resolution: AuthResolution }
  | { kind: "cancelled"; explanation: string };

/**
 * Map a workflow_authenticate input onto an `AuthResolution`, consulting the chosen descriptor so a
 * browser/TTY-only method is never silently mapped to a no-op `completed` (§4.3):
 *   - `env` present  → { outcome: "env", values }
 *   - else `meta`    → { outcome: "meta", methodId, meta }
 *   - else a non-interactive descriptor already completed out-of-band → { outcome: "completed" }
 *   - else (interactive bare-`agent`, or an unknown method id) → cancelled + explanation.
 * The SECRET `env`/`meta` payloads pass THROUGH into the resolution untouched; they never appear in
 * the explanation string or anywhere else this function returns.
 */
export function mapAuthenticateResolution(
  input: { backend: string; methodId: string; env?: Record<string, string>; meta?: Record<string, unknown> },
  descriptor: AuthMethodDescriptor | undefined,
): AuthenticateMapping {
  if (input.env) {
    return { kind: "resolve", resolution: { outcome: "env", values: input.env, methodId: input.methodId } };
  }
  if (input.meta) {
    return { kind: "resolve", resolution: { outcome: "meta", methodId: input.methodId, meta: input.meta } };
  }
  if (descriptor && !isInteractive(descriptor)) {
    return { kind: "resolve", resolution: { outcome: "completed", methodId: input.methodId } };
  }
  const why = descriptor
    ? `Method "${input.methodId}" on backend "${input.backend}" is an interactive login that opens a browser or needs a TTY, which this MCP host does not have.`
    : `Method "${input.methodId}" was not found among backend "${input.backend}"'s advertised auth methods (call workflow_auth_status), or it requires an interactive surface this MCP host does not have.`;
  return {
    kind: "cancelled",
    explanation:
      `${why} Complete it on a browser-capable surface (a web+runner host, or another browser/TTY-capable host — see the auth docs), ` +
      `then re-call the workflow tool with resumeFromRunId to continue.`,
  };
}

/** Human-readable summary for a workflow_auth_status call — backend ids, states, and method ids only
 *  (all non-secret; the redacted projection carries nothing else). */
export function formatAuthStatusSummary(backends: AuthStatusToolBackend[]): string {
  if (backends.length === 0) return "No auth-capable backends are registered.";
  const lines: string[] = [];
  for (const b of backends) {
    lines.push(`backend "${b.backendId}": ${b.state}${b.authenticated ? " (authenticated)" : ""}${b.canResume ? " (resumable)" : ""}`);
    for (const m of b.methods) {
      const flags = m.type === "agent" && m.interactive ? " [interactive — needs a browser/TTY]" : "";
      lines.push(`  - ${m.id} (${m.type})${m.name ? `: ${m.name}` : ""}${flags}`);
    }
  }
  return lines.join("\n");
}

/** Human-readable summary for a completed workflow_authenticate call, built ONLY from the non-secret
 *  `{ status, methodId, recycled }` outcome (Principle 9) — never from the `env`/`meta` inputs. */
export function formatAuthenticateSummary(result: AuthenticateToolResult): string {
  return result.status === "authenticated"
    ? `Authentication succeeded for method "${result.methodId}" (pool recycled: ${result.recycled}). Re-call the workflow tool with resumeFromRunId to continue a paused run.`
    : `Authentication cancelled for method "${result.methodId}".`;
}
