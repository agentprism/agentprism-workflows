import type { AgentRunner } from "@automatalabs/shared-types";
const BUILTIN_BACKEND_IDS = ["claude", "codex", "opencode", "pi"] as const;
import {
  buildHarnessModelsView,
  buildHarnessConfigSummary,
  formatHarnessConfigSummary,
  probeHarnessConfig,
  collapseHarnessOptionsForOutput,
  formatHarnessConfigReport,
  formatValidateReport,
  truncateUtf8,
  type CustomBackendConfig,
  type HarnessConfigReport,
  type ProbedConfigOptions,
  type ValidateProbeRunner,
  type ValidateWorkflowReport,
} from "@automatalabs/workflows";

export const WORKFLOW_DIAGNOSTIC_PROBE_TIMEOUT_MS = 5_000;
export const WORKFLOW_CONFIG_PROBE_TIMEOUT_MS = 15_000;
export const WORKFLOW_CONFIG_DISCOVERY_TIMEOUT_MS = 40_000;

const MAX_STRUCTURED_BYTES = 24_576;
const MAX_HARNESSES = 32;
const MAX_OPTIONS_PER_HARNESS = 48;
const MAX_MODEL_MATCHES = 100;
const MAX_TEXT_BYTES = 8_192;
const MAX_STRING_BYTES = 512;
const MAX_VALUE_DEPTH = 6;
const MAX_VALUE_KEYS = 48;
const MAX_VALUE_ITEMS = 48;

export interface WorkflowConfigSummary {
  [key: string]: unknown;
  action: "config";
  ok: boolean;
  harnessOptions: Array<Record<string, unknown>>;
  omittedHarnesses: number;
  models: Array<Record<string, unknown>>;
  authoringSummary: { harnesses: Array<Record<string, unknown>>; omittedHarnesses: number };
}

interface ProbeRunnerCandidate {
  probeConfigOptions?: (
    spec?: string,
    options?: { cwd?: string; selectModel?: boolean; backends?: Record<string, CustomBackendConfig>; signal?: AbortSignal },
  ) => Promise<ProbedConfigOptions>;
  listBackends?: () => string[];
  listCustomBackends?: () => string[];
}

/** Reuse the server's live runner for no-prompt discovery. A generic AgentRunner that does
 * not implement discovery reports that limitation per harness instead of spawning a second,
 * differently configured runner behind the host's back. */
export function workflowProbeRunner(runner: AgentRunner): ValidateProbeRunner {
  const candidate = runner as AgentRunner & ProbeRunnerCandidate;
  const listBackends =
    typeof candidate.listBackends === "function"
      ? () => candidate.listBackends!()
      : () => [...BUILTIN_BACKEND_IDS];
  if (typeof candidate.probeConfigOptions === "function") {
    return {
      probeConfigOptions: (spec, options) => candidate.probeConfigOptions!(spec, options),
      listBackends,
      ...(typeof candidate.listCustomBackends === "function"
        ? { listCustomBackends: () => candidate.listCustomBackends!() }
        : {}),
    };
  }
  return {
    listBackends,
    async probeConfigOptions() {
      throw new Error("this workflow server's runner does not expose no-prompt config discovery");
    },
  };
}

export function validationText(report: ValidateWorkflowReport): string {
  return truncateUtf8(
    `Workflow preparation validation failed.\n\n${formatValidateReport(report)}`,
    MAX_TEXT_BYTES,
    "…[validation diagnostics truncated]",
  );
}

export function configSummary(report: HarnessConfigReport, modelFilter?: string): WorkflowConfigSummary {
  const projected = projectHarnessOptions(report.harnessOptions);
  const views = buildHarnessModelsView(report, modelFilter).map((view) => {
    const matches = view.matches ?? [];
    return boundValue({
      backendId: view.backendId,
      probed: view.probed,
      error: view.error,
      hasModelOption: view.hasModelOption,
      filter: view.filter,
      total: view.total,
      groups: view.groups,
      matches: matches.slice(0, MAX_MODEL_MATCHES),
      matchCount: matches.length,
      omittedMatches: Math.max(0, matches.length - MAX_MODEL_MATCHES),
    }) as Record<string, unknown>;
  });
  const summary: WorkflowConfigSummary = {
    action: "config",
    ok: report.ok,
    ...projected,
    models: views,
    authoringSummary: {
      harnesses: buildHarnessConfigSummary(report).harnesses.slice(0, MAX_HARNESSES).map(entry => boundValue(entry) as Record<string, unknown>),
      omittedHarnesses: Math.max(0, report.harnessOptions.length - MAX_HARNESSES),
    },
  };
  while (jsonBytes(summary) > MAX_STRUCTURED_BYTES) {
    const harness = summary.harnessOptions.find((entry) =>
      Array.isArray(entry.options) && entry.options.length > 0
    );
    if (harness && Array.isArray(harness.options)) {
      harness.options.pop();
      harness.omittedOptions = Number(harness.omittedOptions ?? 0) + 1;
      continue;
    }
    const model = summary.models.find((entry) => Array.isArray(entry.matches) && entry.matches.length > 0);
    if (model && Array.isArray(model.matches)) {
      model.matches.pop();
      model.omittedMatches = Number(model.omittedMatches ?? 0) + 1;
      continue;
    }
    const grouped = summary.models.find((entry) => Array.isArray(entry.groups) && entry.groups.length > 0);
    if (grouped && Array.isArray(grouped.groups)) {
      grouped.groups.pop();
      continue;
    }
    if (summary.authoringSummary.harnesses.length) {
      summary.authoringSummary.harnesses.pop();
      summary.authoringSummary.omittedHarnesses++;
      continue;
    }
    if (summary.harnessOptions.length) {
      summary.harnessOptions.pop();
      summary.omittedHarnesses++;
      continue;
    }
    if (summary.models.length) { summary.models.pop(); continue; }
    break;
  }
  return summary;
}

function routedModelSpec(backendId: string, modelId: string): string {
  return `${backendId}/${modelId}`;
}

function modelProbeSuggestion(
  report: HarnessConfigReport,
  failed: HarnessConfigReport["harnessOptions"][number],
): { filter: string; matches: string[]; omittedMatches: number } | undefined {
  if (failed.probed || !failed.model) return undefined;
  const rawModel = failed.model.startsWith(`${failed.backendId}/`)
    ? failed.model.slice(failed.backendId.length + 1)
    : failed.model;
  const filters = [...new Set([rawModel, rawModel.split("/").at(-1)].filter((value): value is string =>
    typeof value === "string" && value.length > 0))];
  const baseReport: HarnessConfigReport = {
    ...report,
    harnessOptions: report.harnessOptions.filter((harness) =>
      harness.probed && harness.backendId === failed.backendId && harness.model === undefined),
  };
  for (const filter of filters) {
    const matches = buildHarnessModelsView(baseReport, filter)[0]?.matches ?? [];
    if (matches.length > 0) {
      return {
        filter,
        matches: matches.slice(0, MAX_MODEL_MATCHES).map((modelId) =>
          routedModelSpec(failed.backendId, modelId)),
        omittedMatches: Math.max(0, matches.length - MAX_MODEL_MATCHES),
      };
    }
  }
  return undefined;
}

export function configText(report: HarnessConfigReport, modelFilter?: string): string {
  const lines = ["Live workflow backend configuration (no workflow was started):"];
  if (modelFilter !== undefined) {
    for (const view of buildHarnessModelsView(report, modelFilter)) {
      if (!view.probed) continue;
      const matches = view.matches ?? [];
      lines.push(`${view.backendId}: ${matches.length} model(s) match ${JSON.stringify(modelFilter)}`,
        ...matches.slice(0, MAX_MODEL_MATCHES).map((model) => `  ${routedModelSpec(view.backendId, model)}`));
      if (matches.length > MAX_MODEL_MATCHES) lines.push(`  … ${matches.length - MAX_MODEL_MATCHES} more omitted`);
    }
  }
  for (const harness of report.harnessOptions) {
    const suggestion = modelProbeSuggestion(report, harness);
    if (!suggestion) continue;
    lines.push(
      `${harness.model}: suggested exact modelSpecs: ` +
        suggestion.matches.map((match) => JSON.stringify(match)).join(", ") +
        (suggestion.omittedMatches > 0 ? ` (+${suggestion.omittedMatches} more)` : ""),
      `Discover similar models with modelFilter: ${JSON.stringify(suggestion.filter)}`,
    );
  }
  const exactModelsOnly = report.harnessOptions.length > 0 && report.harnessOptions.every((harness) => harness.model !== undefined);
  if (!exactModelsOnly) lines.push(formatHarnessConfigSummary(buildHarnessConfigSummary(report)));
  lines.push('Config option defaults below are model-specific: backend-only probes describe the backend’s default model. Use action:"config", modelSpecs:["backend/exact-model"] to check the selected model’s options.');
  lines.push(formatHarnessConfigReport(report, { includeSummary: false }));
  return truncateUtf8(lines.join("\n"), MAX_TEXT_BYTES, "…[config diagnostics truncated]");
}

function projectHarnessOptions(harnesses: readonly unknown[]): {
  harnessOptions: Array<Record<string, unknown>>;
  omittedHarnesses: number;
} {
  const collapsed = collapseHarnessOptionsForOutput(harnesses as Parameters<typeof collapseHarnessOptionsForOutput>[0]) ?? [];
  const harnessOptions = collapsed.slice(0, MAX_HARNESSES).map((raw) => {
    const harness = raw as {
      backendId: string;
      defaultModeId?: string;
      model?: string;
      probed: boolean;
      error?: string;
      modes?: unknown;
      options?: unknown[];
    };
    const options = harness.options ?? [];
    return boundValue({
      backendId: harness.backendId,
      defaultModeId: harness.defaultModeId,
      model: harness.model,
      optionScope: harness.model === undefined ? "default-model" : "exact-model",
      probed: harness.probed,
      error: harness.error,
      modes: harness.modes,
      options: options.slice(0, MAX_OPTIONS_PER_HARNESS),
      omittedOptions: Math.max(0, options.length - MAX_OPTIONS_PER_HARNESS),
    }) as Record<string, unknown>;
  });
  return {
    harnessOptions,
    omittedHarnesses: Math.max(0, collapsed.length - MAX_HARNESSES),
  };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundText(value: string): string {
  return truncateUtf8(value, MAX_STRING_BYTES, "…");
}

function boundValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return boundText(value);
  if (value === undefined) return undefined;
  if (depth >= MAX_VALUE_DEPTH) return "[depth bounded]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_VALUE_ITEMS).map((item) => boundValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_VALUE_KEYS)) {
      const bounded = boundValue(item, depth + 1);
      if (bounded !== undefined) output[boundText(key)] = bounded;
    }
    return output;
  }
  return boundText(String(value));
}

/** Bounded, partial discovery supplements a missing route; it never selects one. */
export async function missingRoutingDiagnostics(
  probeRunner: ValidateProbeRunner,
  cwd: string,
  backends?: Record<string, CustomBackendConfig>,
): Promise<string> {
  const guidance = 'Agent routing discovery:\nConfigure the failing agent call with an explicit model route, for example agent("task", { model:"codex" }), or set meta.model. Backend-only routes intentionally use that backend’s configured default model. Discover exact model-specific options with workflow { action:"config", modelSpecs:["backend/exact-model"] }.';
  try {
    const available = [...new Set([...(probeRunner.listBackends?.() ?? BUILTIN_BACKEND_IDS), ...Object.keys(backends ?? {})])];
    const harnesses = available.slice(0, MAX_HARNESSES);
    const omitted = available.length > harnesses.length
      ? `\n${available.length - harnesses.length} additional backends omitted; request workflow action:"config" with explicit harnesses to probe them.`
      : "";
    const report = await probeHarnessConfig({ cwd, harnesses, backends, probeRunner, probeTimeoutMs: WORKFLOW_DIAGNOSTIC_PROBE_TIMEOUT_MS, probeConcurrency: 4 });
    return truncateUtf8(`${guidance}${omitted}\n\n${formatHarnessConfigSummary(buildHarnessConfigSummary(report))}`, MAX_TEXT_BYTES, "…[discovery truncated]");
  } catch (error) {
    return `${guidance}\nDiscovery unavailable: ${boundText(error instanceof Error ? error.message : String(error))}`;
  }
}
