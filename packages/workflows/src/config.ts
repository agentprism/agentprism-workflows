// Harness config discovery — the programmatic core behind `agentprism-workflows config`
// (see ./cli.ts), validate's sibling. Where validate probes only the harnesses a script
// routes to, this probes any requested (or every routable) harness WITHOUT a script:
// one no-prompt ACP session per harness, returning the agent-advertised session
// config-option catalog plus the effective ACP session-mode catalog — model ids
// (including bracket variants), effort levels, modes, and every other negotiable option.
// Zero tokens. Authoring flows run
// this FIRST so `model` / `configOptions` values come from the live catalog, not memory.

import { redactText } from "@automatalabs/workflow-engine";
import {
  BUILTIN_BACKEND_IDS,
  resolveBackendRegistry,
} from "@automatalabs/acp-agents";
import type { CustomBackendConfig } from "@automatalabs/acp-agents";
import { createValidateProbeRunner, type ValidateProbeRunner } from "./validate-internal.js";
import {
  renderHarnessOptionLines,
  selectChoicePairs,
  summarizeSelectChoices,
} from "./validate.js";
import type { SelectChoiceGroup, ValidateHarnessOptions } from "./validate.js";
import type { SessionConfigOption } from "@automatalabs/acp-agents";

export interface ProbeHarnessConfigOptions {
  /** Harness names to probe (built-in `claude` / `codex` / `opencode` / `pi` or a registered
   *  custom name; any model spec routes like an agent() call's). Default: every routable
   *  harness — the four built-ins plus each registered custom backend. */
  harnesses?: string[];
  /** Exact routed model specs to select before reading their model-specific option catalogs. */
  modelSpecs?: string[];
  /** Programmatic custom-backend registry, merged over the AGENTPRISM_BACKENDS env var
   *  exactly like `createAcpRunner({ backends })`. */
  backends?: Record<string, CustomBackendConfig>;
  /** Session cwd for the probes. Default `process.cwd()` — harnesses may resolve
   *  project-level configuration (and hence their catalog) from it. */
  cwd?: string;
  /** Per-harness wall-clock bound. A timed-out harness reports `probed:false` without
   *  affecting the others. Default 60000. */
  timeoutMs?: number;
  /** Host-owned no-prompt probe runner. When supplied it is reused and never disposed. */
  probeRunner?: ValidateProbeRunner;
}

export interface HarnessConfigReport {
  /** True when every requested harness probed successfully. */
  ok: boolean;
  /** 0 = all probed; 1 = at least one probe failed. */
  exitCode: 0 | 1;
  /** One entry per requested harness, in request order — the same shape validate reports. */
  harnessOptions: ValidateHarnessOptions[];
}

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
  const defaultHarnesses = options.probeRunner?.listBackends?.() ?? [...BUILTIN_BACKEND_IDS, ...registry.keys()];
  const harnessTargets =
    options.harnesses && options.harnesses.length > 0
      ? options.harnesses
      : options.modelSpecs && options.modelSpecs.length > 0
        ? []
        : defaultHarnesses;
  const targets = [
    ...new Map(
      [
        ...harnessTargets.map((spec) => ({ spec, selectModel: false })),
        ...(options.modelSpecs ?? []).map((spec) => ({ spec, selectModel: true })),
      ].map((target) => [JSON.stringify([target.spec, target.selectModel]), target]),
    ).values(),
  ];

  const harnessOptions: ValidateHarnessOptions[] = [];
  const ownsRunner = options.probeRunner === undefined;
  const runner = options.probeRunner ?? createValidateProbeRunner(options.backends);
  try {
    for (const target of targets) {
      try {
        const result = await withProbeTimeout(
          (signal) => runner.probeConfigOptions(target.spec, { cwd, selectModel: target.selectModel, signal }),
          timeoutMs,
        );
        harnessOptions.push({
          backendId: result.backendId,
          ...(target.selectModel ? { model: target.spec } : {}),
          probed: true,
          modes: result.modes ?? null,
          options: result.options,
        });
      } catch (error) {
        harnessOptions.push({
          backendId: target.spec.split("/", 1)[0] ?? target.spec,
          ...(target.selectModel ? { model: target.spec } : {}),
          probed: false,
          error: probeErrorMessage(error),
        });
      }
    }
  } finally {
    if (ownsRunner) {
      try {
        await runner.dispose?.();
      } catch {
        // Probe results are already complete; disposal (e.g. of a timed-out process) is best-effort.
      }
    }
  }

  const ok = harnessOptions.every((harness) => harness.probed);
  return { ok, exitCode: ok ? 0 : 1, harnessOptions };
}

/** Render a HarnessConfigReport as the human-readable CLI output (validate's table format). */
export function formatHarnessConfigReport(report: HarnessConfigReport): string {
  const lines: string[] = ["advertised modes and config options:"];
  if (report.harnessOptions.length === 0) {
    lines.push("  (no harnesses requested)");
  } else {
    lines.push(...renderHarnessOptionLines(report.harnessOptions, "  "));
  }
  const probed = report.harnessOptions.filter((harness) => harness.probed).length;
  lines.push(`result: ${probed}/${report.harnessOptions.length} harness(es) probed`);
  return lines.join("\n");
}

/** One harness's slice of the `config <harness> --models[=<filter>]` view. Without a
 *  filter it carries the provider/group breakdown (never the leaf ids); with a filter it
 *  carries only the matching leaf ids. There is no unfiltered leaf dump on any surface. */
export interface HarnessModelsView {
  backendId: string;
  probed: boolean;
  /** Present when probed=false. */
  error?: string;
  /** False when the harness advertises no `model` select option. */
  hasModelOption: boolean;
  /** The filter as given, when one was supplied. */
  filter?: string;
  /** Breakdown mode (no filter): total leaf count and per-group counts. */
  total?: number;
  groups?: SelectChoiceGroup[];
  /** Filter mode: the leaf model ids matching the filter. */
  matches?: string[];
}

/** The `model` select option a harness advertises, if any. */
function modelSelectOption(
  harness: ValidateHarnessOptions,
): Extract<SessionConfigOption, { type: "select" }> | undefined {
  return (harness.options ?? []).find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.type === "select" && option.id === "model",
  );
}

/** Compile a `--models=<filter>` value into a leaf-value matcher. A value wrapped in
 *  slashes (`/.../`) is a case-insensitive regex; anything else is a case-insensitive
 *  substring. Throws a TypeError on an invalid regex (surfaced as a CLI usage error). */
export function buildModelFilter(filter: string): (value: string) => boolean {
  if (filter.length >= 2 && filter.startsWith("/") && filter.endsWith("/")) {
    let re: RegExp;
    try {
      re = new RegExp(filter.slice(1, -1), "i");
    } catch (error) {
      throw new TypeError(`--models: invalid regex ${filter} — ${error instanceof Error ? error.message : String(error)}`);
    }
    return (value) => re.test(value);
  }
  const needle = filter.toLowerCase();
  return (value) => value.toLowerCase().includes(needle);
}

/** Build the per-harness `--models` view. `filter` undefined = breakdown mode. */
export function buildHarnessModelsView(
  report: HarnessConfigReport,
  filter?: string,
): HarnessModelsView[] {
  const match = filter === undefined ? undefined : buildModelFilter(filter);
  return report.harnessOptions.map((harness) => {
    if (!harness.probed) {
      return { backendId: harness.backendId, probed: false, error: harness.error, hasModelOption: false };
    }
    const model = modelSelectOption(harness);
    if (!model) {
      return { backendId: harness.backendId, probed: true, hasModelOption: false };
    }
    if (match === undefined) {
      const { total, groups } = summarizeSelectChoices(model);
      return { backendId: harness.backendId, probed: true, hasModelOption: true, total, groups };
    }
    const matches = selectChoicePairs(model)
      .map((pair) => pair.value)
      .filter((value) => match(value));
    return { backendId: harness.backendId, probed: true, hasModelOption: true, filter, matches };
  });
}

/** Render the `config <harness> --models[=<filter>]` view as human text. */
export function formatHarnessModels(views: readonly HarnessModelsView[]): string {
  const lines: string[] = [];
  if (views.length === 0) {
    lines.push("(no harnesses requested)");
    return lines.join("\n");
  }
  for (const view of views) {
    if (!view.probed) {
      lines.push(`${view.backendId}: probe failed — ${view.error ?? "unknown error"}`);
      continue;
    }
    if (!view.hasModelOption) {
      lines.push(`${view.backendId}: no model option advertised`);
      continue;
    }
    if (view.filter === undefined) {
      const groups = view.groups ?? [];
      lines.push(`${view.backendId}: ${view.total ?? 0} models in ${groups.length} group(s):`);
      for (const group of groups) lines.push(`  ${group.group} (${group.count})`);
      lines.push(`  narrow with: config ${view.backendId} --models=<provider|substring|/regex/>`);
    } else {
      const matches = view.matches ?? [];
      lines.push(`${view.backendId}: ${matches.length} model(s) matching ${JSON.stringify(view.filter)}${matches.length ? ":" : ""}`);
      for (const value of matches) lines.push(`  ${value}`);
    }
  }
  return lines.join("\n");
}

/** Bound one probe; the underlying promise keeps its handlers, so a late settle is inert. */
function withProbeTimeout<T>(op: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`probe timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
    op(controller.signal).then(
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
