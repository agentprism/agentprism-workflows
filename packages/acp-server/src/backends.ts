import {
  BUILTIN_BACKEND_IDS,
  CustomAcpBackend,
  builtinBackend,
  openRawBackendConnection,
  resolveBackendRegistry,
  type CustomBackendConfig,
  type RawBackendConnection,
} from "@automatalabs/acp-agents";

export const ACP_BACKEND_ID_PATTERN = /^[a-z][a-z0-9._-]*$/;

const BUILTIN_TITLES: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "pi",
};

export interface BackendTarget {
  readonly id: string;
  readonly name: string;
  open(): Promise<RawBackendConnection>;
}

export interface ResolveBackendTargetsOptions {
  /** Programmatic custom backends merged over AGENTPRISM_BACKENDS by acp-agents. */
  backends?: Record<string, CustomBackendConfig>;
  /** Environment used for AGENTPRISM_BACKENDS resolution. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export function indexBackendTargets(targets: readonly BackendTarget[]): Map<string, BackendTarget> {
  const indexed = new Map<string, BackendTarget>();
  for (const target of targets) {
    if (!ACP_BACKEND_ID_PATTERN.test(target.id)) {
      throw new Error(
        `ACP backend target id ${JSON.stringify(target.id)} must match ${ACP_BACKEND_ID_PATTERN}`,
      );
    }
    if (indexed.has(target.id)) {
      throw new Error(`ACP backend target id ${JSON.stringify(target.id)} is duplicated`);
    }
    indexed.set(target.id, target);
  }
  return indexed;
}

/** Resolve the same built-in and operator-registered backend namespace used by acp-agents. */
export function resolveBackendTargets(options: ResolveBackendTargetsOptions = {}): BackendTarget[] {
  const targets = new Map<string, BackendTarget>();

  for (const id of BUILTIN_BACKEND_IDS) {
    const backend = builtinBackend(id);
    if (!backend) throw new Error(`Built-in ACP backend ${JSON.stringify(id)} is unavailable`);
    targets.set(id, {
      id,
      name: BUILTIN_TITLES[id] ?? id,
      open: () => openRawBackendConnection(backend),
    });
  }

  for (const [id, config] of resolveBackendRegistry(options.backends, options.env)) {
    const backend = new CustomAcpBackend(config);
    targets.set(id, {
      id,
      name: id,
      open: () => openRawBackendConnection(backend),
    });
  }

  return [...targets.values()];
}
