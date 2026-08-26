import {
  AcpAgentRunner,
  type CustomBackendConfig,
  type ProbedConfigOptions,
} from "@automatalabs/acp-agents";

export interface ValidateProbeRunner {
  probeConfigOptions(
    spec?: string,
    opts?: { cwd?: string; selectModel?: boolean; backends?: Record<string, CustomBackendConfig>; signal?: AbortSignal },
  ): Promise<ProbedConfigOptions>;
  /** Every host-routable backend name. Used by protocol-native discovery. */
  listBackends?(): string[];
  /** Host-registered custom names, including deliberate built-in shadows. */
  listCustomBackends?(): string[];
  /** The host's backend selected when a workflow omits model. */
  defaultBackendId?(): string;
  /** Present on owned probe runners; shared host runners are never disposed by validation. */
  dispose?(): Promise<void>;
}

export type ValidateProbeFactory = (
  backends: Record<string, CustomBackendConfig> | undefined,
) => ValidateProbeRunner;

let probeFactory: ValidateProbeFactory = (backends) => new AcpAgentRunner({ backends });

export function createValidateProbeRunner(
  backends: Record<string, CustomBackendConfig> | undefined,
): ValidateProbeRunner {
  return probeFactory(backends);
}

/** Package-internal hermetic test seam. Deliberately absent from the public index export. */
export function setValidateProbeFactoryForTests(factory: ValidateProbeFactory): () => void {
  const previous = probeFactory;
  probeFactory = factory;
  return () => {
    probeFactory = previous;
  };
}
