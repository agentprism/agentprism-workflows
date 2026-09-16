// Per-agent traits — what the AcpAgent SDK knows about a backend BEFORE it spawns (the executable
// protocol-coverage tables plus the Backend object's own behavior) and what the live agent
// ADVERTISED at initialize once a connection is open. Read-only data for callers: it never gates
// a call by itself. The pre-open validators (`assertSystemPromptSupported`, the fork cwd rule)
// keep reading the tables, so a refused option is refused before a process exists; the traits
// tell the caller what the table says and, after open, what the agent actually advertised.
import { Type } from "typebox";
import { CODEX_CUSTOM_CAPABILITY_NAMESPACE, CODEX_META_KEYS, META_KEYS } from "@automatalabs/shared-types";
import { LOADED_TURN_QUERY_METHOD, SESSION_STEERING_METHOD } from "./acp-client.js";
import { forkTraitFor } from "./agent/fork.js";
import type { Backend } from "./backend.js";
import type { NegotiatedCapabilities } from "./capabilities.js";
import {
  ACP_EXTENSION_SUPPORT_MATRIX,
  SYSTEM_PROMPT_UNSUPPORTED,
  promptUsageScope,
  type ForkSessionTraitRow,
  type SystemPromptSupport,
} from "./protocol-coverage.js";
import type { BackendRegistry } from "./registry.js";

/** The traits of one agent's backend: routing identity, the `session/fork` row the SDK follows,
 *  the system-prompt channel and where that answer came from, the two vendor extensions, the
 *  structured-output channel, and the `PromptResponse.usage` scope. Frozen; `AcpAgent#traits` and
 *  `AcpAgent.traits()` hand out a fresh object per read. */
export interface AcpAgentTraits {
  /** The resolved backend id (a built-in id or a registered custom name). */
  readonly backendId: string;
  /** `true` for a registry (custom) backend, `false` for one of the built-in adapters — a registry
   *  lookup, like the fork trait, so a custom entry that shadows a built-in name is `custom`. */
  readonly custom: boolean;
  /** The mode the SDK selects when the caller omits `mode` and the catalog advertises it. */
  readonly defaultModeId?: string;
  /** The `session/fork` row the SDK's fork choreography follows (`forkTraitFor`): a built-in's
   *  `FORK_SESSION_TRAITS` row, or a custom entry's declaration. */
  readonly fork: ForkSessionTraitRow;
  /** Which halves of `systemPrompt` the backend carries and where the answer came from: `table`
   *  (a built-in's `SYSTEM_PROMPT_SUPPORT` row), `advertised` (the live agent's initialize
   *  advertisement — pi under `_meta.systemPrompt`, the Codex fork under
   *  `agentCapabilities._meta["@automatalabs/codex-acp"]` — which wins over the table once the
   *  connection is open), or `none` (no channel — every custom backend before open, since
   *  `CustomAcpBackend` never carries the neutral instructions; a built-in that supports neither
   *  half, OpenCode, still reports its all-false row as `table`). */
  readonly systemPrompt: SystemPromptSupport & { readonly source: "table" | "advertised" | "none" };
  /** `_session/steering`: the built-in `ACP_EXTENSION_SUPPORT_MATRIX` row before open (`unknown`
   *  for a custom backend); after open, whether `initializeMeta.steering.supported === true`. */
  readonly steering: "supported" | "not-advertised" | "unknown";
  /** `_session/loaded_turn/query`, derived exactly like `steering` (`initializeMeta.loadedTurn`). */
  readonly loadedTurn: "supported" | "not-advertised" | "unknown";
  /** How a `schema` reaches this backend, from the Backend object's behavior: `client-tool` (the
   *  injected StructuredOutput MCP tool plus the in-prompt contract — pi, OpenCode, custom),
   *  `turn-meta` (the schema rides every turn's `_meta` — Codex), or `session-meta` (bound at
   *  session open — Claude). */
  readonly structuredOutput: "session-meta" | "turn-meta" | "client-tool";
  /** What `PromptResponse.usage` covers (`PROMPT_USAGE_SCOPES`): every agent reports the turn. */
  readonly promptUsage: "turn";
}

/** A trivial schema for probing which channel `Backend.promptMeta` carries the schema on. */
const PROBE_SCHEMA = Type.Object({ ok: Type.Boolean() });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Describe `backend`'s traits. Without `live`, every answer comes from the tables and the Backend
 * object; with `live` (the negotiated capabilities of an open connection) the initialize
 * advertisements refine `systemPrompt`, `steering`, and `loadedTurn`. `registry` is the registry
 * the backend was routed through — a registered name is a custom backend and follows its own
 * declarations, never a built-in's rows.
 */
export function describeBackendTraits(
  backend: Backend,
  registry: BackendRegistry,
  live?: NegotiatedCapabilities,
): AcpAgentTraits {
  const custom = registry.has(backend.id);
  const initializeMeta = isRecord(live?.initializeMeta) ? live.initializeMeta : undefined;
  return Object.freeze({
    backendId: backend.id,
    custom,
    ...(backend.defaultModeId === undefined ? {} : { defaultModeId: backend.defaultModeId }),
    fork: forkTraitFor(backend, registry),
    systemPrompt: systemPromptTrait(backend, live),
    steering: extensionTrait(backend.id, custom, SESSION_STEERING_METHOD, live, initializeMeta?.steering),
    loadedTurn: extensionTrait(backend.id, custom, LOADED_TURN_QUERY_METHOD, live, initializeMeta?.loadedTurn),
    structuredOutput: structuredOutputChannel(backend),
    promptUsage: promptUsageScope(backend.id),
  });
}

/** The live advertisement wins; else the Backend object's row — set only by the built-ins
 *  (`SYSTEM_PROMPT_SUPPORT`), never by `CustomAcpBackend`, so a defined row is always `table`. */
function systemPromptTrait(backend: Backend, live: NegotiatedCapabilities | undefined): AcpAgentTraits["systemPrompt"] {
  const advertised = live ? advertisedSystemPrompt(live) : undefined;
  if (advertised) return Object.freeze({ ...advertised, source: "advertised" as const });
  const table = backend.systemPrompt;
  if (!table) return Object.freeze({ ...SYSTEM_PROMPT_UNSUPPORTED, source: "none" as const });
  return Object.freeze({ replace: table.replace, append: table.append, source: "table" as const });
}

/** The live system-prompt advertisement, when the agent made one: the bare `_meta.systemPrompt`
 *  block (`{ replace, append }` booleans — pi), else the Codex fork's namespaced capability block
 *  (`baseInstructions` => replace, `developerInstructions` => append). An agent that advertises
 *  neither (Claude) returns undefined and the table stands. */
function advertisedSystemPrompt(live: NegotiatedCapabilities): SystemPromptSupport | undefined {
  const initializeMeta = isRecord(live.initializeMeta) ? live.initializeMeta : undefined;
  const bare = initializeMeta?.[META_KEYS.systemPrompt];
  if (isRecord(bare)) return { replace: bare.replace === true, append: bare.append === true };
  const agentMeta = isRecord(live.agent._meta) ? live.agent._meta : undefined;
  const namespace = agentMeta?.[CODEX_CUSTOM_CAPABILITY_NAMESPACE];
  if (
    isRecord(namespace) &&
    (CODEX_META_KEYS.baseInstructions in namespace || CODEX_META_KEYS.developerInstructions in namespace)
  ) {
    return {
      replace: namespace[CODEX_META_KEYS.baseInstructions] === true,
      append: namespace[CODEX_META_KEYS.developerInstructions] === true,
    };
  }
  return undefined;
}

function extensionTrait(
  backendId: string,
  custom: boolean,
  method: typeof SESSION_STEERING_METHOD | typeof LOADED_TURN_QUERY_METHOD,
  live: NegotiatedCapabilities | undefined,
  advertisement: unknown,
): AcpAgentTraits["steering"] {
  if (live) return isRecord(advertisement) && advertisement.supported === true ? "supported" : "not-advertised";
  if (custom) return "unknown";
  const row = ACP_EXTENSION_SUPPORT_MATRIX.find((candidate) => candidate.agent === backendId && candidate.method === method);
  return row?.disposition ?? "unknown";
}

/** Derived from the Backend object's behavior, never its id: a backend that opts into the injected
 *  tool is `client-tool`; else one whose `promptMeta` carries the schema is `turn-meta`; else the
 *  schema is bound at session open (`session-meta`). */
function structuredOutputChannel(backend: Backend): AcpAgentTraits["structuredOutput"] {
  if (backend.injectStructuredOutputTool === true) return "client-tool";
  const turnMeta = backend.promptMeta(PROBE_SCHEMA);
  if (turnMeta !== undefined && Object.keys(turnMeta).length > 0) return "turn-meta";
  return "session-meta";
}
