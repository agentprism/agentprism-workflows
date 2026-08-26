import type { AgentRunner } from "@automatalabs/shared-types";
const BUILTIN_BACKEND_IDS = ["claude", "codex", "opencode", "pi"] as const;
import {
  buildHarnessModelsView,
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

const MAX_STRUCTURED_BYTES = 24_576;
const MAX_HARNESSES = 32;
const MAX_OPTIONS_PER_HARNESS = 48;
const MAX_MODEL_MATCHES = 100;
const MAX_AGENT_CALLS = 64;
const MAX_CHECKPOINTS = 32;
const MAX_WARNINGS = 32;
const MAX_TEXT_BYTES = 8_192;
const MAX_STRING_BYTES = 512;
const MAX_VALUE_DEPTH = 6;
const MAX_VALUE_KEYS = 48;
const MAX_VALUE_ITEMS = 48;

export interface WorkflowValidationSummary {
  ok: false;
  exitCode: 1 | 2;
  parse: {
    ok: boolean;
    error?: string;
    meta?: { name: string; description: string; phases: string[] };
  };
  dryRun?: {
    ok: boolean;
    status: string;
    reason?: string;
    timedOut: boolean;
    durationMs: number;
    agentCalls: Array<Record<string, unknown>>;
    omittedAgentCalls: number;
    checkpoints: Array<Record<string, unknown>>;
    omittedCheckpoints: number;
    phasesVisited: string[];
    harnessOptions: Array<Record<string, unknown>>;
    omittedHarnesses: number;
  };
  warnings: string[];
  omittedWarnings: number;
}

export interface WorkflowConfigSummary {
  [key: string]: unknown;
  action: "config";
  ok: boolean;
  harnessOptions: Array<Record<string, unknown>>;
  omittedHarnesses: number;
  models: Array<Record<string, unknown>>;
}

interface ProbeRunnerCandidate {
  probeConfigOptions?: (
    spec?: string,
    options?: { cwd?: string; selectModel?: boolean; backends?: Record<string, CustomBackendConfig>; signal?: AbortSignal },
  ) => Promise<ProbedConfigOptions>;
  listBackends?: () => string[];
  listCustomBackends?: () => string[];
  defaultBackendId?: () => string;
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
      ...(typeof candidate.defaultBackendId === "function"
        ? { defaultBackendId: () => candidate.defaultBackendId!() }
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

export function validationSummary(report: ValidateWorkflowReport): WorkflowValidationSummary {
  if (report.ok) throw new TypeError("validationSummary requires an invalid report");
  const warnings = report.warnings.slice(0, MAX_WARNINGS).map(boundText);
  const dry = report.dryRun;
  const summary: WorkflowValidationSummary = {
    ok: false,
    exitCode: report.exitCode as 1 | 2,
    parse: {
      ok: report.parse.ok,
      ...(report.parse.error === undefined ? {} : { error: boundText(report.parse.error) }),
      ...(report.parse.meta === undefined
        ? {}
        : {
            meta: {
              name: boundText(report.parse.meta.name),
              description: boundText(report.parse.meta.description),
              phases: (report.parse.meta.phases ?? []).slice(0, 32).map((phase) => boundText(phase.title)),
            },
          }),
    },
    ...(dry === undefined
      ? {}
      : {
          dryRun: {
            ok: dry.ok,
            status: boundText(dry.status),
            ...(dry.reason === undefined ? {} : { reason: boundText(dry.reason) }),
            timedOut: dry.timedOut,
            durationMs: Math.max(0, dry.durationMs),
            agentCalls: dry.agentCalls.slice(0, MAX_AGENT_CALLS).map((call) =>
              boundValue({
                label: call.label,
                phase: call.phase,
                model: call.model,
                tier: call.tier,
                mode: call.mode,
                configOptions: call.configOptions,
                backend: call.backend,
                schema: call.schema,
              }) as Record<string, unknown>,
            ),
            omittedAgentCalls: Math.max(0, dry.agentCalls.length - MAX_AGENT_CALLS),
            checkpoints: dry.checkpoints.slice(0, MAX_CHECKPOINTS).map((checkpoint) =>
              boundValue({ prompt: checkpoint.prompt, kind: checkpoint.kind }) as Record<string, unknown>,
            ),
            omittedCheckpoints: Math.max(0, dry.checkpoints.length - MAX_CHECKPOINTS),
            phasesVisited: dry.phasesVisited.slice(0, 32).map(boundText),
            ...projectHarnessOptions(dry.harnessOptions ?? []),
          },
        }),
    warnings,
    omittedWarnings: Math.max(0, report.warnings.length - MAX_WARNINGS),
  };
  while (jsonBytes(summary) > MAX_STRUCTURED_BYTES) {
    if (summary.dryRun && summary.dryRun.agentCalls.length > 0) {
      summary.dryRun.agentCalls.pop();
      summary.dryRun.omittedAgentCalls++;
      continue;
    }
    if (summary.dryRun && summary.dryRun.checkpoints.length > 0) {
      summary.dryRun.checkpoints.pop();
      summary.dryRun.omittedCheckpoints++;
      continue;
    }
    const harness = summary.dryRun?.harnessOptions.find((entry) =>
      Array.isArray(entry.options) && entry.options.length > 0
    );
    if (harness && Array.isArray(harness.options)) {
      harness.options.pop();
      harness.omittedOptions = Number(harness.omittedOptions ?? 0) + 1;
      continue;
    }
    if (summary.warnings.length > 0) {
      summary.warnings.pop();
      summary.omittedWarnings++;
      continue;
    }
    break;
  }
  return summary;
}

export function validationText(report: ValidateWorkflowReport): string {
  return truncateUtf8(
    `Workflow validation failed before admission. No run was created.\n\n${formatValidateReport(report)}`,
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
    break;
  }
  return summary;
}

export function configText(report: HarnessConfigReport, modelFilter?: string): string {
  const lines = [
    "Live workflow backend configuration (no workflow was started):",
    formatHarnessConfigReport(report),
  ];
  if (modelFilter !== undefined) {
    const views = buildHarnessModelsView(report, modelFilter);
    for (const view of views) {
      if (!view.probed) continue;
      const matches = view.matches ?? [];
      lines.push(
        `${view.backendId}: ${matches.length} model(s) match ${JSON.stringify(modelFilter)}`,
        ...matches.slice(0, MAX_MODEL_MATCHES).map((model) => `  ${model}`),
      );
      if (matches.length > MAX_MODEL_MATCHES) lines.push(`  … ${matches.length - MAX_MODEL_MATCHES} more omitted`);
    }
  }
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
      model?: string;
      probed: boolean;
      error?: string;
      options?: unknown[];
    };
    const options = harness.options ?? [];
    return boundValue({
      backendId: harness.backendId,
      model: harness.model,
      probed: harness.probed,
      error: harness.error,
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
