import {
  BUILTIN_BACKEND_IDS,
  CustomAcpBackend,
  builtinBackend,
  openRawBackendConnection,
  resolveBackendRegistry,
  type CustomBackendConfig,
  type RawBackendConnection,
} from "@automatalabs/acp-agents";

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
