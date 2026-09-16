// Model routing — the runner's grammar for turning a model/tier spec into a Backend plus the
// verbatim model value handed to session/set_config_option. Extracted from runner.ts as a pure
// move so the SDK-style AcpAgent (src/agent/) can share it instead of copying it.
//
// `asciiLowercase` and `assertNoModelConfigOption` are module exports for runner.ts and
// src/agent only — deliberately NOT re-exported from the package barrel. `defaultBackend` stays
// module-private: it reads AGENTPRISM_DEFAULT_BACKEND and nothing outside resolveModelRoute needs it.
import { WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import type { Backend } from "./backend.js";
import { BUILTIN_BACKENDS, builtinBackend } from "./backends/builtins.js";
import { CustomAcpBackend } from "./backends/custom.js";
import type { BackendRegistry } from "./registry.js";

export interface ModelRoute {
  backend: Backend;
  modelSpec: string | undefined;
}

/** Resolve routing and the verbatim model value together so backend choice and prefix stripping
 *  cannot drift. A registered custom name has priority over a built-in on collision. */
export function resolveModelRoute(spec: string | undefined, registry?: BackendRegistry): ModelRoute {
  if (spec === undefined) return { backend: defaultBackend(registry), modelSpec: undefined };

  const slash = spec.indexOf("/");
  const firstSegment = asciiLowercase(slash >= 0 ? spec.slice(0, slash) : spec);
  const inner = slash >= 0 ? spec.slice(slash + 1) : undefined;
  const custom = registry?.get(firstSegment);
  if (custom) return { backend: new CustomAcpBackend(custom), modelSpec: inner };

  const builtIn = builtinBackend(firstSegment);
  if (builtIn) return { backend: builtIn, modelSpec: inner };

  return { backend: defaultBackend(registry), modelSpec: spec };
}

/** Resolve the default backend: a registered custom name wins (returned as a Backend), else
 *  the built-in id. An unknown/unset value falls back to "claude" (the historical default). */
function defaultBackend(registry?: BackendRegistry): Backend {
  const configured = process.env.AGENTPRISM_DEFAULT_BACKEND;
  const name = configured === undefined ? undefined : asciiLowercase(configured);
  if (name && registry) {
    const config = registry.get(name);
    if (config) return new CustomAcpBackend(config);
  }
  if (name) {
    const builtIn = builtinBackend(name);
    if (builtIn) return builtIn;
  }
  return BUILTIN_BACKENDS.claude.create();
}

/** Exported for src/agent/routing.ts (`resolveRefRoute`); deliberately NOT in the barrel. */
export function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

/** Exported for runner.ts and src/agent; deliberately NOT in the barrel. */
export function assertNoModelConfigOption(
  configOptions: Record<string, string | boolean> | undefined,
  label: string | undefined,
): void {
  if (!configOptions || !("model" in configOptions)) return;
  throw new WorkflowError(
    `Agent call${label ? ` "${label}"` : ""} configOptions must not contain reserved option id "model"; use the model field instead`,
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false, agentLabel: label },
  );
}
