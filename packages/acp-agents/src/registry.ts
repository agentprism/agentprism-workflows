// The custom-backend REGISTRY — lets any ACP agent plug in as an agent() target, not just the
// built-in Claude/Codex pair. A registered backend is (name -> how to spawn it + optional static
// session `_meta`), resolved once at runner construction from:
//   1. the programmatic option: createAcpRunner({ backends: { name: config } })   (wins per name)
//   2. the env var AGENTPRISM_BACKENDS: a JSON object of the same shape
// Routing then matches `model`/`tier` specs against registered names FIRST (exact name, or
// `name/<inner-model>` prefix), before the built-in claude/codex heuristics — see runner.ts.
// Names are case-insensitive (stored lowercased); "claude" and "codex" are reserved because the
// built-ins own their ids (and their own AGENTPRISM_*_ACP_CMD override channel).

export const BACKENDS_ENV = "AGENTPRISM_BACKENDS";

const RESERVED_NAMES = new Set(["claude", "codex"]);
const NAME_PATTERN = /^[a-z][a-z0-9._-]*$/;

/** How to spawn (and optionally pre-configure) one custom ACP backend. */
export interface CustomBackendConfig {
  /** The ACP server executable (absolute path or on PATH). */
  command: string;
  /** Arguments for the command. Default []. */
  args?: string[];
  /** Extra environment for the subprocess, merged OVER the inherited process.env. */
  env?: Record<string, string>;
  /** Static `_meta` sent on every session/new for this backend (backend-level defaults).
   *  Per-call RunOptions.meta merges over these; backend-computed keys win over both. */
  sessionMeta?: Record<string, unknown>;
  /** agentCapabilities._meta namespace + bare `_meta` keys this custom agent negotiates.
   *  Undefined means the backend's custom `_meta`, if any, is never gated. */
  customCapabilities?: { readonly namespace: string; readonly gatedKeys: readonly string[] };
  /** Enable client-hosted StructuredOutput MCP tool injection when schema runs negotiate HTTP MCP.
   *  Default true; set false for custom agents that should use only the generic prompt/_meta path. */
  structuredOutputTool?: boolean;
}

/** A validated registry entry: the (lowercased) name plus its config. */
export interface RegisteredBackend extends CustomBackendConfig {
  name: string;
}

export type BackendRegistry = ReadonlyMap<string, RegisteredBackend>;

/**
 * Resolve the custom-backend registry: env-declared backends first, programmatic `backends`
 * merged over them (option wins per name). Throws on malformed JSON, invalid names/configs, or
 * reserved names — a misconfigured registry should fail LOUDLY at construction, not silently
 * misroute at run time.
 */
export function resolveBackendRegistry(
  option?: Record<string, CustomBackendConfig>,
  env: NodeJS.ProcessEnv = process.env,
): BackendRegistry {
  const registry = new Map<string, RegisteredBackend>();

  const raw = env[BACKENDS_ENV];
  if (raw !== undefined && raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${BACKENDS_ENV} is not valid JSON: ${(error as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${BACKENDS_ENV} must be a JSON object of { "<name>": { "command": … } }`);
    }
    for (const [name, config] of Object.entries(parsed as Record<string, unknown>)) {
      registry.set(...validateEntry(name, config, BACKENDS_ENV));
    }
  }

  for (const [name, config] of Object.entries(option ?? {})) {
    registry.set(...validateEntry(name, config, "backends option"));
  }

  return registry;
}

/**
 * Layer a RUN-SCOPED registry (an approved script-declared `meta.backends`, arriving via
 * RunOptions.backends) UNDER the host registry: run entries are validated with the same rules
 * (reserved names rejected), and a host-registered name always wins on conflict — a script can
 * never hijack a name the operator configured. Returns the host registry unchanged when the
 * run declares nothing.
 */
export function registryWithRunBackends(
  host: BackendRegistry,
  run?: Record<string, CustomBackendConfig>,
): BackendRegistry {
  if (!run || Object.keys(run).length === 0) return host;
  const merged = new Map<string, RegisteredBackend>();
  for (const [name, config] of Object.entries(run)) {
    merged.set(...validateEntry(name, config, "script backends (meta.backends)"));
  }
  for (const [name, entry] of host) merged.set(name, entry); // host wins on conflict
  return merged;
}

function validateEntry(rawName: string, config: unknown, source: string): [string, RegisteredBackend] {
  const name = rawName.toLowerCase();
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `${source}: invalid backend name "${rawName}" (must match ${NAME_PATTERN}, matched case-insensitively)`,
    );
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(
      `${source}: backend name "${rawName}" is reserved for the built-in backend (use AGENTPRISM_${name.toUpperCase()}_ACP_CMD to override how it spawns)`,
    );
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${source}: backend "${rawName}" must be an object with at least { command }`);
  }
  const c = config as Record<string, unknown>;
  if (typeof c.command !== "string" || c.command.trim() === "") {
    throw new Error(`${source}: backend "${rawName}" needs a non-empty string "command"`);
  }
  if (c.args !== undefined && !(Array.isArray(c.args) && c.args.every((a) => typeof a === "string"))) {
    throw new Error(`${source}: backend "${rawName}" "args" must be an array of strings`);
  }
  if (c.env !== undefined && !isStringRecord(c.env)) {
    throw new Error(`${source}: backend "${rawName}" "env" must be an object of string values`);
  }
  if (c.sessionMeta !== undefined && (c.sessionMeta === null || typeof c.sessionMeta !== "object" || Array.isArray(c.sessionMeta))) {
    throw new Error(`${source}: backend "${rawName}" "sessionMeta" must be an object`);
  }
  if (c.structuredOutputTool !== undefined && typeof c.structuredOutputTool !== "boolean") {
    throw new Error(`${source}: backend "${rawName}" "structuredOutputTool" must be a boolean`);
  }
  const customCapabilities = validateCustomCapabilities(c.customCapabilities, source, rawName);
  return [
    name,
    {
      name,
      command: c.command,
      ...(c.args !== undefined ? { args: c.args as string[] } : {}),
      ...(c.env !== undefined ? { env: c.env as Record<string, string> } : {}),
      ...(c.sessionMeta !== undefined ? { sessionMeta: c.sessionMeta as Record<string, unknown> } : {}),
      ...(c.structuredOutputTool !== undefined ? { structuredOutputTool: c.structuredOutputTool as boolean } : {}),
      ...(customCapabilities !== undefined ? { customCapabilities } : {}),
    },
  ];
}

function validateCustomCapabilities(
  value: unknown,
  source: string,
  rawName: string,
): CustomBackendConfig["customCapabilities"] | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: backend "${rawName}" "customCapabilities" must be an object`);
  }
  const c = value as Record<string, unknown>;
  if (typeof c.namespace !== "string" || c.namespace.trim() === "") {
    throw new Error(`${source}: backend "${rawName}" "customCapabilities.namespace" must be a non-empty string`);
  }
  if (
    !Array.isArray(c.gatedKeys) ||
    c.gatedKeys.length === 0 ||
    !c.gatedKeys.every((key) => typeof key === "string" && key.trim() !== "")
  ) {
    throw new Error(
      `${source}: backend "${rawName}" "customCapabilities.gatedKeys" must be a non-empty array of non-empty strings`,
    );
  }
  return { namespace: c.namespace, gatedKeys: [...c.gatedKeys] as string[] };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}
