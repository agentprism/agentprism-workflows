// Harness config discovery — the programmatic core behind `agentprism-workflows config`
// (see ./cli.ts), validate's sibling. Where validate probes only the harnesses a script
// routes to, this probes any requested (or every routable) harness WITHOUT a script:
// one no-prompt ACP session per harness, returning the agent-advertised session
// config-option catalog verbatim — model ids (including bracket variants), effort
// levels, modes, and every other negotiable option. Zero tokens. Authoring flows run
// this FIRST so `model` / `configOptions` values come from the live catalog, not memory.

import { redactText } from "@automatalabs/workflow-engine";
import { resolveBackendRegistry } from "@automatalabs/acp-agents";
import type { CustomBackendConfig } from "@automatalabs/acp-agents";
import { createValidateProbeRunner } from "./validate-internal.js";
import { renderHarnessOptionLines } from "./validate.js";
import type { ValidateHarnessOptions } from "./validate.js";

export interface ProbeHarnessConfigOptions {
  /** Harness names to probe (built-in `claude` / `codex` / `opencode` / `pi` or a registered
   *  custom name; any model spec routes like an agent() call's). Default: every routable
   *  harness — the four built-ins plus each registered custom backend. */
  harnesses?: string[];
  /** Programmatic custom-backend registry, merged over the AGENTPRISM_BACKENDS env var
   *  exactly like `createAcpRunner({ backends })`. */
  backends?: Record<string, CustomBackendConfig>;
  /** Session cwd for the probes. Default `process.cwd()` — harnesses may resolve
   *  project-level configuration (and hence their catalog) from it. */
  cwd?: string;
  /** Per-harness wall-clock bound. A timed-out harness reports `probed:false` without
   *  affecting the others. Default 60000. */
  timeoutMs?: number;
}

export interface HarnessConfigReport {
  /** True when every requested harness probed successfully. */
  ok: boolean;
  /** 0 = all probed; 1 = at least one probe failed. */
  exitCode: 0 | 1;
  /** One entry per requested harness, in request order — the same shape validate reports. */
  harnessOptions: ValidateHarnessOptions[];
}

const BUILTIN_HARNESSES = ["claude", "codex", "opencode", "pi"] as const;
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

/**
 * Probe each requested harness's advertised config-option catalog. A per-harness
 * spawn/auth/session failure (or timeout) is reported as `probed:false` on that entry —
 * never thrown. Only caller configuration errors throw: a malformed AGENTPRISM_BACKENDS /
 * `backends` registry (loud at construction, mirroring `createAcpRunner`) or invalid options.
 */
export async function probeHarnessConfig(
  options: ProbeHarnessConfigOptions = {},
): Promise<HarnessConfigReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("probeHarnessConfig: timeoutMs must be a positive number");
  }
  const cwd = options.cwd ?? process.cwd();
  const registry = resolveBackendRegistry(options.backends);
  const targets = [
    ...new Set(
      options.harnesses && options.harnesses.length > 0
        ? options.harnesses
        : [...BUILTIN_HARNESSES, ...registry.keys()],
    ),
  ];

  const harnessOptions: ValidateHarnessOptions[] = [];
  const runner = createValidateProbeRunner(options.backends);
  try {
    for (const target of targets) {
      try {
        const result = await withProbeTimeout(runner.probeConfigOptions(target, { cwd }), timeoutMs);
        harnessOptions.push({ backendId: result.backendId, probed: true, options: result.options });
      } catch (error) {
        harnessOptions.push({ backendId: target, probed: false, error: probeErrorMessage(error) });
      }
    }
  } finally {
    try {
      await runner.dispose();
    } catch {
      // Probe results are already complete; disposal (e.g. of a timed-out process) is best-effort.
    }
  }

  const ok = harnessOptions.every((harness) => harness.probed);
  return { ok, exitCode: ok ? 0 : 1, harnessOptions };
}

/** Render a HarnessConfigReport as the human-readable CLI output (validate's table format). */
export function formatHarnessConfigReport(report: HarnessConfigReport): string {
  const lines: string[] = ["advertised config options:"];
  if (report.harnessOptions.length === 0) {
    lines.push("  (no harnesses requested)");
  } else {
    lines.push(...renderHarnessOptionLines(report.harnessOptions, "  "));
  }
  const probed = report.harnessOptions.filter((harness) => harness.probed).length;
  lines.push(`result: ${probed}/${report.harnessOptions.length} harness(es) probed`);
  return lines.join("\n");
}

/** Bound one probe; the underlying promise keeps its handlers, so a late settle is inert. */
function withProbeTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
    timer.unref?.();
    op.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function probeErrorMessage(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error)).value;
}
