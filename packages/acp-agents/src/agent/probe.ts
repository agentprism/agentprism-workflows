// `AcpAgent.probe`: the no-prompt harness catalog over the moved config-catalog core, driven by a
// dedicated-connection probe runner (one process per target, disposed afterwards — the SDK owns no
// pool), and reproducing the MCP `action:"config"` missing-catalog re-probe so a failed exact-model
// probe still returns the bare harness catalog next to the failure.
import type { SessionHandle } from "../acp-client.js";
import { PooledConnection, isChildCleanupError } from "../acp-client.js";
import {
  buildHarnessModelsView,
  buildModelFilter,
  probeHarnessConfig,
  type ValidateProbeRunner,
} from "../config-catalog.js";
import { mapThrownError } from "../errors-map.js";
import { registryWithRunBackends, type CustomBackendConfig } from "../registry.js";
import { resolveModelRoute } from "../routing.js";
import { describeBackendTraits } from "../traits.js";
import { releaseOnExit, retainOnExit } from "./process-registry.js";
import { resolveAgentRegistry } from "./routing.js";
import type { AcpAgentCatalog, AcpAgentProbeOptions } from "./types.js";

/** A `ValidateProbeRunner` over a dedicated connection per probe: spawn, initialize, one no-prompt
 *  session/new (+ model selection for exact specs), read the catalog, release, dispose. No
 *  `listBackends`/`defaultBackendId`/`dispose`: `probeHarnessConfig` derives the default targets
 *  from the registry itself and never owns a caller-supplied runner. */
export function createAgentProbeRunner(backends: Record<string, CustomBackendConfig> | undefined): ValidateProbeRunner {
  return {
    async probeConfigOptions(spec, opts = {}) {
      opts.signal?.throwIfAborted();
      const registry = registryWithRunBackends(resolveAgentRegistry(backends), opts.backends);
      const route = resolveModelRoute(spec, registry);
      const cwd = opts.cwd ?? process.cwd();
      const connection = PooledConnection.create(route.backend, { onDead: () => undefined });
      retainOnExit(connection);
      // Unsticks a hung initialize/session-new: the raced wire call rejects with the death error.
      const onAbort = (): void => {
        void connection.dispose();
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      let handle: SessionHandle | undefined;
      try {
        handle = await connection.openSession({ cwd, schema: undefined, policy: {} });
        opts.signal?.throwIfAborted();
        if (opts.selectModel && route.modelSpec !== undefined) await handle.selectModel(route.modelSpec);
        return {
          backendId: route.backend.id,
          ...(route.backend.defaultModeId === undefined ? {} : { defaultModeId: route.backend.defaultModeId }),
          options: handle.advertisedConfigOptions,
          modes: handle.modes ?? null,
          // The live refinement: pi and the Codex fork advertise their system-prompt channel and the
          // two vendor extensions at initialize; Claude advertises nothing and reports the tables.
          traits: describeBackendTraits(route.backend, registry, connection.capabilities),
        };
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
        try {
          await handle?.release();
        } catch (error) {
          if (isChildCleanupError(error)) {
            throw mapThrownError(error, { backendId: route.backend.id, backend: route.backend });
          }
        }
        await connection.dispose().catch(() => undefined);
        releaseOnExit(connection);
      }
    },
  };
}

/** The catalog behind `AcpAgent.probe` (see the file header). Per-target failures never throw
 *  (`probed: false` with a redacted `error`); a bad `modelFilter`, `probeTimeoutMs`, or
 *  `probeConcurrency` throws a TypeError and a malformed registry an INVALID_ARGUMENT — all
 *  before any process spawns. */
export async function probeCatalog(options: AcpAgentProbeOptions = {}): Promise<AcpAgentCatalog> {
  // Validation only: a bad regex must surface BEFORE any spawn (the MCP handler does the same).
  if (options.modelFilter !== undefined) buildModelFilter(options.modelFilter);
  // The SDK surfaces a malformed registry as a WorkflowError; probeHarnessConfig re-reads it.
  resolveAgentRegistry(options.backends);
  const modelSpecs = [...(options.model === undefined ? [] : [options.model]), ...(options.models ?? [])];
  const probeRunner = createAgentProbeRunner(options.backends);
  const common = {
    backends: options.backends,
    cwd: options.cwd,
    probeTimeoutMs: options.probeTimeoutMs,
    probeConcurrency: options.probeConcurrency,
    signal: options.signal,
    probeRunner,
  };
  let report = await probeHarnessConfig({ harnesses: options.harnesses, modelSpecs, ...common });
  // Mirror the MCP `action:"config"` fallback: when an exact model probe fails, still return the
  // bare harness catalog next to the failure so the caller can pick a valid id.
  const missingCatalogBackends = [...new Set(
    report.harnessOptions
      .filter((harness) => !harness.probed && harness.model !== undefined)
      .map((harness) => harness.backendId)
      .filter((backendId) => !report.harnessOptions.some((harness) =>
        harness.probed && harness.backendId === backendId && harness.model === undefined)),
  )];
  if (missingCatalogBackends.length > 0) {
    const catalogs = await probeHarnessConfig({ harnesses: missingCatalogBackends, ...common });
    report = { ok: false, exitCode: 1, harnessOptions: [...report.harnessOptions, ...catalogs.harnessOptions] };
  }
  return { ...report, models: buildHarnessModelsView(report, options.modelFilter) };
}
