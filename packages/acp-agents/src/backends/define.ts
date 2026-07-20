import type { AuthProfile } from "../auth/auth-profile.js";
import type { Backend } from "../backend.js";
import type { BuiltinProtocolCoverageRow } from "../protocol-coverage.js";

export interface BuiltinBackendForkMetadata {
  readonly package: string;
  readonly envDir: string;
  readonly defaultDirs: readonly string[];
  readonly tempCloneName: string;
  readonly originUrl: string;
  readonly originUrlEnv: string;
  readonly upstreamUrl: string;
  readonly upstreamUrlEnv: string;
  readonly upstreamRemote: string;
}

export interface BuiltinBackendWrappedRuntimeMetadata {
  readonly adapterPackage: string;
  readonly runtimePackage: string;
}

export type BuiltinBackendServerMetadata =
  | { readonly kind: "npm-package"; readonly package: string }
  | { readonly kind: "workspace-package"; readonly package: string; readonly path: string }
  | {
      readonly kind: "system-command";
      readonly command: string;
      readonly optionalPackageProbe?: string;
    };

export interface BuiltinBackendReleaseMetadata {
  readonly engine: { readonly node: string };
  readonly server: BuiltinBackendServerMetadata;
  readonly freshness: {
    readonly npm: readonly string[];
    readonly forks: readonly BuiltinBackendForkMetadata[];
    readonly wrappedRuntimes: readonly BuiltinBackendWrappedRuntimeMetadata[];
  };
}

export interface BuiltinBackendDefinition<Id extends string> {
  readonly id: Id;
  readonly authProfile: AuthProfile;
  readonly create: () => Backend & {
    readonly id: Id;
    readonly authProfile: AuthProfile;
  };
  readonly release: BuiltinBackendReleaseMetadata;
  readonly protocolCoverage: BuiltinProtocolCoverageRow;
}

export interface DefineBuiltinBackendOptions<Id extends string> {
  readonly id: Id;
  readonly authProfile: AuthProfile;
  readonly create: (authProfile: AuthProfile) => Backend & {
    readonly id: Id;
    readonly authProfile: AuthProfile;
  };
  readonly release: BuiltinBackendReleaseMetadata;
  readonly protocolCoverage: BuiltinProtocolCoverageRow;
}

/** Compose and validate a built-in while retaining ownership only of its release metadata tree. */
export function defineBuiltinBackend<const Id extends string>(
  options: DefineBuiltinBackendOptions<Id>,
): BuiltinBackendDefinition<Id> {
  if (options.authProfile.backendId !== options.id) {
    throw new Error(
      `Built-in backend definition id "${options.id}" does not match auth profile id "${options.authProfile.backendId}"`,
    );
  }

  const release = cloneAndFreeze(options.release);
  const definition: BuiltinBackendDefinition<Id> = {
    id: options.id,
    authProfile: options.authProfile,
    release,
    protocolCoverage: options.protocolCoverage,
    create: () => {
      const backend = options.create(options.authProfile);
      if (backend.id !== options.id) {
        throw new Error(
          `Built-in backend factory for "${options.id}" returned backend id "${backend.id}"`,
        );
      }
      if (backend.authProfile !== options.authProfile) {
        throw new Error(
          `Built-in backend factory for "${options.id}" did not attach its exact auth profile object`,
        );
      }
      return backend;
    },
  };
  return Object.freeze(definition);
}

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreeze(entry))) as T;
  }
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) clone[key] = cloneAndFreeze(entry);
    return Object.freeze(clone) as T;
  }
  return value;
}
