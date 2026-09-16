import { AcpAgentRunner, type CustomBackendConfig, type ValidateProbeRunner } from "@automatalabs/acp-agents";

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
