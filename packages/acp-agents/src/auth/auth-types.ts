// Host-agnostic, fully type-dispatched auth-flow contracts (§1.3). The library NEVER runs an
// interactive step itself (Principle 5): it emits an `AuthContext` and consumes an `AuthResolution`.
// Every type here is dispatched on `AuthMethod.type` (SDK-typed) + the cross-agent `_meta` key
// conventions (`gateway`/`terminal-auth`; NOT SDK schema fields — the SDK types every `_meta` as
// opaque). There is ZERO agent-*id* branching anywhere in this file.
//
// ACP schema 1.21.0 (`@agentclientprotocol/sdk` 1.4.0, agentclientprotocol/agent-client-protocol
// #1796/#2000) removed the `env_var` method variant; `AuthMethod` is now `agent | terminal` and the
// former `env_var` descriptor is gone with it. Host-supplied env credentials still ride the `env`
// resolution outcome against an `agent` method (e.g. codex `api-key`) and are injected at spawn.
//
// Secret material flows only through resolver RETURN values and the spawn env — never through
// events, journals, logs, or error messages (Principle 9). The advertised `_meta` a descriptor
// carries here (e.g. `gateway.protocol`, `api-key.provider`) is agent-PUBLISHED metadata, not a
// credential; the credential is only ever the resolver's `env`/`meta` payload.
import type { AuthMethod } from "@agentclientprotocol/sdk";
import type { SpawnConfig } from "../backend.js";

/** Host-agnostic, fully type-dispatched view of one advertised `AuthMethod`. ZERO backend branching. */
export type AuthMethodDescriptor =
  | {
      type: "agent";
      id: string;
      name: string;
      description?: string;
      /** true iff the advertised `authMethods[]._meta` block is present (a `_meta` object exists —
       *  gateway OR api-key convention). Whether it is *gateway-shaped* is a SEPARATE test that
       *  drives `klass` (§2.1), not `expectsMeta`. */
      expectsMeta: boolean;
      meta?: Record<string, unknown>;
      /** true iff this is a bare `agent` method (no `_meta`) that runs its OWN login via the
       *  authenticate RPC — which may open a browser or need a TTY (e.g. codex `chat-gpt`).
       *  Derived as `!expectsMeta`. Headless hosts (MCP/SDK) use this to SKIP a method they cannot
       *  complete instead of mapping it to a no-op (§4.3). */
      interactive: boolean;
    }
  | {
      type: "terminal";
      id: string;
      name: string;
      description?: string;
      /** How the host spawns the interactive login. Base fills from EITHER the conventional
       *  `_meta["terminal-auth"] {command,args,label}` (preferred; not an SDK schema field), OR the
       *  agent binary + `AuthMethodTerminal.args`/`env` (spec baseline). */
      launch: { command: string; args: string[]; env?: Record<string, string>; label?: string };
      meta?: Record<string, unknown>;
    };

/** The host-collected outcome of one auth step. `env`/`meta` payloads are SECRET (Principle 9). */
export type AuthResolution =
  // disk cred already present out-of-band (terminal login done, or native store / env pre-set) — no RPC
  | { outcome: "completed"; methodId?: string }
  // bare `agent` method runs its OWN login NOW via a one-shot authenticate({ methodId }) RPC
  | { outcome: "agent-login"; methodId: string }
  // host-supplied env credentials (SECRET) for an `agent` method whose credential is read from the
  // spawn environment (e.g. codex `api-key`); injected at spawn via the §2.8 overlay
  | { outcome: "env"; values: Record<string, string>; methodId?: string }
  // agent-type payload, e.g. gateway (SECRET)
  | { outcome: "meta"; methodId: string; meta: Record<string, unknown> }
  | { outcome: "cancelled" };

export interface AuthContext {
  readonly backendId: string;
  readonly label?: string;
  /** All advertised methods, already dispatched by `buildAuthDescriptors`. */
  readonly methods: readonly AuthMethodDescriptor[];
  /** `required` = we hit -32000; `proactive` = pre-run enumeration. */
  readonly cause: "required" | "proactive";
  readonly signal?: AbortSignal;
}

/** The host-facing inline auth resolver hook. Mirrors PermissionResolver / ElicitationResolver. */
export type AuthResolver = (ctx: AuthContext) => Promise<AuthResolution> | AuthResolution;

/** The conventional launch-hint key (`_meta["terminal-auth"] = {command,args,label}`) both claude
 *  0.57.0 and opencode 1.17.14 attach to a terminal login method. Recognized by literal name; it is
 *  NOT an SDK schema field. */
const TERMINAL_AUTH_META_KEY = "terminal-auth";
/** The conventional in-process gateway key (`_meta.gateway`) claude+codex attach to a gateway
 *  method. Its PRESENCE (a gateway-shaped `_meta`) is what makes us classify a method `in-process`
 *  (§2.1). Recognized by literal name; NOT an SDK schema field. */
export const GATEWAY_META_KEY = "gateway";

/** A `_meta` object counts as gateway-shaped iff it carries the literal `gateway` key with a
 *  non-null value. This is the single discriminant behind `in-process` classification (§2.1);
 *  codex `api-key` carries a `_meta["api-key"]` block and is therefore NOT gateway-shaped. */
export function isGatewayShapedMeta(meta: Record<string, unknown> | null | undefined): boolean {
  return meta != null && meta[GATEWAY_META_KEY] != null;
}

function metaOf(method: AuthMethod): Record<string, unknown> | undefined {
  const meta = (method as { _meta?: Record<string, unknown> | null })._meta;
  return meta ?? undefined;
}

/** The SDK types a missing `type` discriminant as `agent` (AuthMethodAgent carries no `type`). */
function typeOf(method: AuthMethod): "agent" | "terminal" {
  return (("type" in method ? method.type : undefined) ?? "agent") as "agent" | "terminal";
}

function terminalAuthHint(
  meta: Record<string, unknown> | undefined,
): { command: string; args: string[]; label?: string } | undefined {
  const hint = meta?.[TERMINAL_AUTH_META_KEY];
  if (!hint || typeof hint !== "object") return undefined;
  const record = hint as { command?: unknown; args?: unknown; label?: unknown };
  if (typeof record.command !== "string") return undefined;
  const args = Array.isArray(record.args) ? record.args.filter((a): a is string => typeof a === "string") : [];
  return { command: record.command, args, ...(typeof record.label === "string" ? { label: record.label } : {}) };
}

/** true iff a bare `agent` method (`type` absent OR "agent") is semantically a TERMINAL login —
 *  i.e. it carries a `_meta["terminal-auth"]` launch hint. This is why OpenCode's bare-`agent`
 *  `opencode-login` becomes a `terminal` descriptor for us, while codex's `gateway` (which carries
 *  `_meta.gateway`, not `terminal-auth`) does not (§3.1 decision). */
function isTerminalShaped(method: AuthMethod): boolean {
  if (typeOf(method) === "terminal") return true;
  return terminalAuthHint(metaOf(method)) !== undefined;
}

/** Pure, agent-agnostic per-method dispatcher (§1.3): maps each advertised `AuthMethod` to an
 *  `AuthMethodDescriptor` with NO agent identity. `spawn` supplies the terminal-launch fallback
 *  (the agent binary + `AuthMethodTerminal.args`). */
export function buildAuthDescriptors(methods: readonly AuthMethod[], spawn: SpawnConfig): AuthMethodDescriptor[] {
  return methods.map((method) => buildAuthDescriptor(method, spawn));
}

export function buildAuthDescriptor(method: AuthMethod, spawn: SpawnConfig): AuthMethodDescriptor {
  const meta = metaOf(method);
  const description = method.description ?? undefined;
  const type = typeOf(method);

  if (isTerminalShaped(method)) {
    // Launch resolution, both branches agent-id-free:
    //   1. Method carries `_meta["terminal-auth"] = {command,args,label}` → use verbatim.
    //   2. Pure-spec fallback → agent binary + AuthMethodTerminal.args/env.
    const hint = terminalAuthHint(meta);
    const terminalMethod = type === "terminal" ? (method as Extract<AuthMethod, { type: "terminal" }>) : undefined;
    const launch = hint
      ? { command: hint.command, args: hint.args, ...(hint.label ? { label: hint.label } : {}) }
      : {
          command: spawn.command,
          args: [...spawn.args, ...(terminalMethod?.args ?? [])],
          ...(terminalMethod?.env ? { env: { ...terminalMethod.env } } : {}),
        };
    return {
      type: "terminal",
      id: method.id,
      name: method.name,
      ...(description ? { description } : {}),
      launch,
      ...(meta ? { meta } : {}),
    };
  }

  // agent (AuthMethodAgent, or the default when `type` is absent):
  const expectsMeta = meta != null;
  return {
    type: "agent",
    id: method.id,
    name: method.name,
    ...(description ? { description } : {}),
    expectsMeta,
    interactive: !expectsMeta,
    ...(meta ? { meta } : {}),
  };
}
