// Harness config discovery — the token-free catalog probe behind `agentprism-workflows config`
// (the CLI lives in @automatalabs/workflows; that facade re-exports everything here) and the
// SDK's `AcpAgent.probe`. Where validate probes only the harnesses a script routes to, this
// probes any requested (or every routable) harness WITHOUT a script: one no-prompt ACP session
// per harness, returning the agent-advertised session config-option catalog plus the effective
// ACP session-mode catalog — model ids (including bracket variants), effort levels, modes, and
// every other negotiable option. Zero tokens. Authoring flows run this FIRST so `model` /
// `configOptions` values come from the live catalog, not memory.

import type { SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import { redactText } from "@automatalabs/shared-types";
import { BUILTIN_BACKEND_IDS } from "./backends/builtins.js";
import { resolveBackendRegistry, type CustomBackendConfig } from "./registry.js";
import { AcpAgentRunner, type ProbedConfigOptions } from "./runner.js";
import type { AcpAgentTraits } from "./traits.js";

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

export type ConfigProbeFactory = (
  backends: Record<string, CustomBackendConfig> | undefined,
) => ValidateProbeRunner;

let probeFactory: ConfigProbeFactory = (backends) => new AcpAgentRunner({ backends });

/** Package-internal hermetic test seam. Deliberately absent from the public index export. */
export function setConfigProbeFactoryForTests(factory: ConfigProbeFactory): () => void {
  const previous = probeFactory;
  probeFactory = factory;
  return () => {
    probeFactory = previous;
  };
}

export interface ValidateHarnessOptions {
  backendId: string;
  /** AgentPrism's explicit mode when the call omits mode; absent for no-mode/custom backends. */
  defaultModeId?: string;
  /** The call's verbatim selected model; absent means the harness/session default. */
  model?: string;
  probed: boolean;
  /** Present when probed=false: the harness's spawn/auth/session error. */
  error?: string;
  /** Effective advertised ACP modes; null means this backend/model supports no session modes. */
  modes?: SessionModeState | null;
  options?: SessionConfigOption[];
  /** Present when probed=true and the probe runner reports it (the runner and the SDK probe always
   *  do): the backend's traits refined by the live initialize advertisements. */
  traits?: AcpAgentTraits;
}

type SelectConfigOption = Extract<SessionConfigOption, { type: "select" }>;

/** Every leaf {value,label} the select advertises, flattening any advertised optgroups. */
export function selectChoicePairs(option: SelectConfigOption): { value: string; label?: string }[] {
  return option.options
    .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
    .map((entry) => ({ value: entry.value, label: entry.name }));
}

export interface SelectChoiceGroup {
  group: string;
  count: number;
}

export interface SelectChoiceSummary {
  total: number;
  groups: SelectChoiceGroup[];
}

/** The group a bare (ungrouped) choice value belongs to: its first "/"-segment
 *  (pi/opencode ids are "<provider>/<model>"); a value with no "/" is "(ungrouped)". */
function groupOfValue(value: string): string {
  const slash = value.indexOf("/");
  return slash > 0 ? value.slice(0, slash) : "(ungrouped)";
}

/**
 * Group a select's choices for summary display. Prefers the harness-advertised optgroup
 * labels; absent those, groups by the first "/"-segment of each value. Groups come back
 * largest-first, ties broken by first appearance.
 */
export function summarizeSelectChoices(option: SelectConfigOption): SelectChoiceSummary {
  const counts = new Map<string, number>();
  const order: string[] = [];
  const bump = (name: string, n: number): void => {
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) ?? 0) + n);
  };
  const hasAdvertisedGroups = option.options.some((entry) => "options" in entry);
  for (const entry of option.options) {
    if ("options" in entry) bump(entry.name ?? entry.group, entry.options.length);
    else if (hasAdvertisedGroups) bump(groupOfValue(entry.value), 1); // stray leaf beside groups
    else bump(groupOfValue(entry.value), 1);
  }
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const groups = order
    .map((group) => ({ group, count: counts.get(group) ?? 0 }))
    .sort((a, b) => b.count - a.count || order.indexOf(a.group) - order.indexOf(b.group));
  return { total, groups };
}

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
  /** Host-owned no-prompt probe runner. When supplied it is reused and never disposed. */
  probeRunner?: ValidateProbeRunner;
  /** Per-probe cancellation deadline in milliseconds. Default 60,000; lifecycle
   *  diagnostics can use a shorter bound. Must be a positive timer-safe integer. */
  probeTimeoutMs?: number;
  /** Maximum concurrent probes, from 1 to 16. Default 4. */
  probeConcurrency?: number;
  /** Shared discovery cancellation budget. Completed catalogs are retained; active
   * probes are aborted and queued targets become failed entries without starting. */
  signal?: AbortSignal;
}

export interface HarnessConfigReport {
  /** True when every requested harness probed successfully. */
  ok: boolean;
  /** 0 = all probed; 1 = at least one probe failed. */
  exitCode: 0 | 1;
  /** One entry per requested harness, in request order — the same shape validate reports. */
  harnessOptions: ValidateHarnessOptions[];
  /** Bounded presentation alongside the complete supported catalog. */
  authoringSummary?: HarnessConfigSummary;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

/**
 * Probe each requested harness's advertised config-option catalog. A per-harness
 * spawn/auth/session failure (or timeout) is reported as `probed:false` on that entry —
 * never thrown. Only caller configuration errors throw: a malformed AGENTPRISM_BACKENDS /
 * `backends` registry (loud at construction, mirroring `createAcpRunner`) or invalid options.
 */
export async function probeHarnessConfig(
  options: ProbeHarnessConfigOptions = {},
): Promise<HarnessConfigReport> {
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const concurrency = options.probeConcurrency ?? 4;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new TypeError("probeTimeoutMs must be a positive integer no greater than 2147483647");
  }
  if (!Number.isInteger(concurrency) || concurrency <= 0 || concurrency > 16) {
    throw new TypeError("probeConcurrency must be an integer between 1 and 16");
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

  const harnessOptions: ValidateHarnessOptions[] = new Array(targets.length);
  const ownsRunner = options.probeRunner === undefined;
  const runner = options.probeRunner ?? probeFactory(options.backends);
  try {
    let nextTarget = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      while (nextTarget < targets.length) {
        const index = nextTarget++;
        const target = targets[index];
        try {
          const result = await withProbeTimeout(
            (signal) => runner.probeConfigOptions(target.spec, {
              cwd,
              selectModel: target.selectModel,
              backends: options.backends,
              signal,
            }),
            timeoutMs,
            options.signal,
          );
          harnessOptions[index] = {
            backendId: result.backendId,
            ...(result.defaultModeId === undefined ? {} : { defaultModeId: result.defaultModeId }),
            ...(target.selectModel ? { model: target.spec } : {}),
            probed: true,
            modes: result.modes ?? null,
            options: result.options,
            ...(result.traits === undefined ? {} : { traits: result.traits }),
          };
        } catch (error) {
          harnessOptions[index] = {
            backendId: target.spec.split("/", 1)[0] ?? target.spec,
            ...(target.selectModel ? { model: target.spec } : {}),
            probed: false,
            error: probeErrorMessage(error),
          };
        }
      }
    }));
  } finally {
    if (ownsRunner) {
      try {
        // Always initiate owned cleanup, including after cancellation, without
        // letting stalled disposal extend the caller's discovery budget.
        const disposal = Promise.resolve().then(() => runner.dispose?.());
        void disposal.catch(() => {});
        await withProbeTimeout(() => disposal, timeoutMs, options.signal);
      } catch {
        // Probe results are already complete; disposal (e.g. of a timed-out process) is best-effort.
      }
    }
  }

  const ok = harnessOptions.every((harness) => harness.probed);
  return {
    ok, exitCode: ok ? 0 : 1, harnessOptions,
    authoringSummary: buildHarnessConfigSummary({ harnessOptions }),
  };
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

/** Bound one probe; the underlying promise keeps its handlers, so a late settle is inert. */
function withProbeTimeout<T>(op: (signal: AbortSignal) => Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("config discovery cancelled"));
      return;
    }
    const controller = new AbortController();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const abort = (reason: unknown) => {
      cleanup();
      controller.abort(reason);
      reject(reason);
    };
    const onAbort = () => abort(signal?.reason ?? new Error("config discovery cancelled"));
    const timer = setTimeout(() => abort(new Error(`probe timed out after ${ms}ms`)), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    // Keep the deadline alive even if a stalled runner has no referenced handles.
    // Defer invocation so synchronous throws also clear the timer through this path.
    Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return op(controller.signal);
    }).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function probeErrorMessage(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error)).value;
}

// ── The bounded authoring summary ──

const MAX_ENTRIES = 24;
const MAX_VALUE_LENGTH = 240;
// Deliberate classification by exact provider id, never a substring/name heuristic.
const OPENCODE_AGGREGATORS = new Set([
  "openrouter", "opencode", "opencode-go", "huggingface", "amazon-bedrock", "github-copilot",
]);
const MODEL_DISCOVERY_META = "@automatalabs/agentprism.modelDiscovery";

export interface HarnessConfigSummaryModel {
  modelId: string;
  /** Exact executable route; browse selectors never appear here. */
  route: string;
}

export interface HarnessConfigSummaryGroup {
  provider: string;
  count: number;
  kind: "provider" | "aggregator";
  /** Presentation only. Expand with modelFilter; never pass to agent(). */
  selector?: string;
  modelFilter: string;
}

export interface HarnessConfigSummaryEntry {
  backendId: string;
  /** Exact-model probe scope, when selected before reading options. */
  model?: string;
  probed: boolean;
  error?: string;
  hasModelOption: boolean;
  /** Actual complete live catalog size, before presentation limits/preferences. */
  total: number;
  /** Current selection is separate from preferred models; it need not be preferred. */
  currentModel?: string;
  /** Present only when the current model is an advertised executable leaf. */
  currentRoute?: string;
  omittedCurrentModel?: true;
  models: HarnessConfigSummaryModel[];
  omittedModels: number;
  groups: HarnessConfigSummaryGroup[];
  omittedGroups: number;
  omittedGroupModels: number;
  preferenceSource?: "enabledModels";
  /** Available preferred models before presentation limits. */
  preferredTotal?: number;
  unmatched: string[];
  omittedUnmatched: number;
}

export interface HarnessConfigSummary {
  /** One entry per requested probe, including unavailable backends, in request order. */
  harnesses: HarnessConfigSummaryEntry[];
}

function boundedLabel(value: string): string {
  return value.length <= MAX_VALUE_LENGTH
    ? value
    : `${value.slice(0, MAX_VALUE_LENGTH)}… (${value.length - MAX_VALUE_LENGTH} characters omitted)`;
}

function display(value: string): string {
  return boundedLabel(redactText(value).value);
}

function providerOf(value: string): string {
  const slash = value.indexOf("/");
  return slash > 0 ? value.slice(0, slash) : "(ungrouped)";
}

function providerFilter(provider: string): string {
  return provider === "(ungrouped)"
    ? "/^[^/]+$/"
    : `/^${provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\//`;
}

function preferences(value: unknown): { preferred: string[]; unmatched: string[] } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const meta = value as Record<string, unknown>;
  if (meta.source !== "enabledModels" || !Array.isArray(meta.preferred) || !Array.isArray(meta.unmatched)) {
    return undefined;
  }
  if (!meta.preferred.every((id) => typeof id === "string") || !meta.unmatched.every((id) => typeof id === "string")) {
    return undefined;
  }
  return { preferred: meta.preferred as string[], unmatched: meta.unmatched as string[] };
}

/** Compact live authoring guidance. Does not mutate or restrict the supported catalog.
 * Lists are bounded per harness; omitted counts and exact expansion filters are explicit.
 * Options such as effort remain authoritative only for the exact probed model. */
export function buildHarnessConfigSummary(
  report: Pick<HarnessConfigReport, "harnessOptions">,
): HarnessConfigSummary {
  return {
    harnesses: report.harnessOptions.map((harness): HarnessConfigSummaryEntry => {
      const entry: HarnessConfigSummaryEntry = {
        backendId: boundedLabel(harness.backendId),
        ...(harness.model === undefined ? {} : { model: boundedLabel(harness.model) }),
        probed: harness.probed,
        ...(!harness.probed ? { error: display(harness.error ?? "unknown error") } : {}),
        hasModelOption: false,
        total: 0, models: [], omittedModels: 0, groups: [], omittedGroups: 0,
        omittedGroupModels: 0, unmatched: [], omittedUnmatched: 0,
      };
      if (!harness.probed) return entry;
      const model = harness.options?.find((option) => option.id === "model" && option.type === "select");
      if (!model || model.type !== "select") return entry;
      entry.hasModelOption = true;
      const ids = selectChoicePairs(model).map(({ value }) => value);
      entry.total = ids.length;
      if (model.currentValue) {
        const route = `${harness.backendId}/${model.currentValue}`;
        if (route.length <= MAX_VALUE_LENGTH) {
          entry.currentModel = model.currentValue;
          if (ids.includes(model.currentValue) && !model.currentValue.includes("*")) entry.currentRoute = route;
        } else entry.omittedCurrentModel = true;
      }
      const groups = new Map<string, number>();
      for (const id of ids) {
        const provider = providerOf(id);
        groups.set(provider, (groups.get(provider) ?? 0) + 1);
      }
      const isAggregator = (provider: string) =>
        harness.backendId === "opencode" && OPENCODE_AGGREGATORS.has(provider);
      // Stable sorting preserves catalog provider order within each classification.
      const orderedGroups = [...groups].sort(([a], [b]) => Number(isAggregator(a)) - Number(isAggregator(b)));
      for (const [provider, count] of orderedGroups) {
        if (entry.groups.length >= MAX_ENTRIES || provider.length > MAX_VALUE_LENGTH) {
          entry.omittedGroups++;
          entry.omittedGroupModels += count;
          continue;
        }
        entry.groups.push({
          provider, count,
          kind: isAggregator(provider) ? "aggregator" : "provider",
          ...(isAggregator(provider) ? { selector: `${provider}/*` } : {}),
          modelFilter: providerFilter(provider),
        });
      }
      const preferred = harness.backendId === "pi" ? preferences(model._meta?.[MODEL_DISCOVERY_META]) : undefined;
      let candidates: string[];
      if (preferred) {
        const available = new Set(ids);
        candidates = [...new Set(preferred.preferred)].filter((id) => available.has(id));
        entry.preferenceSource = "enabledModels";
        entry.preferredTotal = candidates.length;
        entry.unmatched = preferred.unmatched.slice(0, MAX_ENTRIES).map(display);
        entry.omittedUnmatched = preferred.unmatched.length - entry.unmatched.length;
      } else if (harness.backendId === "pi") {
        candidates = [];
      } else if (harness.backendId === "opencode") {
        // When direct catalogs exceed the display bound, represent each configured
        // direct provider before filling more rows from any one provider.
        const direct = new Map<string, string[]>();
        for (const id of ids) {
          const provider = providerOf(id);
          if (isAggregator(provider)) continue;
          const group = direct.get(provider) ?? [];
          group.push(id);
          direct.set(provider, group);
        }
        candidates = [];
        for (let index = 0; [...direct.values()].some((values) => index < values.length); index++) {
          for (const values of direct.values()) if (values[index] !== undefined) candidates.push(values[index]);
        }
      } else {
        candidates = ids.filter((id) => !isAggregator(providerOf(id)));
      }
      for (const id of candidates) {
        const route = `${harness.backendId}/${id}`;
        if (entry.models.length >= MAX_ENTRIES || route.length > MAX_VALUE_LENGTH || id.includes("*")) continue;
        entry.models.push({ modelId: id, route });
      }
      entry.omittedModels = entry.total - entry.models.length;
      return entry;
    }),
  };
}

/** Format the bounded summary for both explicit discovery and missing-route diagnostics. */
export function formatHarnessConfigSummary(summary: HarnessConfigSummary): string {
  const lines = ["authoring model summary:"];
  if (!summary.harnesses.length) lines.push("  (no harnesses requested)");
  for (const harness of summary.harnesses) {
    const label = harness.model ?? harness.backendId;
    if (!harness.probed) {
      lines.push(`  ${JSON.stringify(label)}: unavailable — ${JSON.stringify(harness.error)}`);
      continue;
    }
    if (!harness.hasModelOption) {
      lines.push(`  ${JSON.stringify(label)}: no model option advertised`);
      continue;
    }
    lines.push(`  ${JSON.stringify(label)}: ${harness.total} supported model(s)`);
    if (harness.currentModel !== undefined) {
      lines.push(`    current model: ${JSON.stringify(harness.currentRoute ?? harness.currentModel)}`);
    }
    if (harness.omittedCurrentModel) lines.push("    current model omitted by summary length limit; inspect the model config option");
    if (harness.preferenceSource) {
      lines.push(`    Pi enabledModels: ${harness.preferredTotal} available preferred model(s); presentation shortlist, not an execution allowlist`);
    } else if (harness.backendId === "pi") {
      lines.push("    No enabledModels preference metadata; showing available provider groups");
    }
    for (const model of harness.models) lines.push(`    model: ${JSON.stringify(model.route)}`);
    if (harness.omittedModels) lines.push(`    ${harness.omittedModels} supported model(s) not listed as exact routes here; expand with modelFilter`);
    for (const group of harness.groups) {
      lines.push(`    ${group.kind === "aggregator" ? "browse only (not executable)" : "provider"}: ${JSON.stringify(group.selector ?? group.provider)} (${group.count} models); modelFilter: ${JSON.stringify(group.modelFilter)}`);
    }
    if (harness.omittedGroups) lines.push(`    ${harness.omittedGroups} provider group(s), ${harness.omittedGroupModels} models omitted by summary limits; use config modelFilter`);
    if (harness.unmatched.length) lines.push(`    unmatched enabledModels patterns: ${harness.unmatched.map((value) => JSON.stringify(value)).join(", ")}`);
    if (harness.omittedUnmatched) lines.push(`    ${harness.omittedUnmatched} additional unmatched enabledModels pattern(s) omitted by summary limits`);
  }
  lines.push('  Browse wildcards are not executable. Expand with config harnesses:["<backend>"], modelFilter:"<substring or /regex/>"; use an exact returned leaf route in agent(prompt, { model }).');
  lines.push('  Default-model options do not describe every model. Probe config modelSpecs:["<exact route>"] before choosing mode/effort/configOptions. A backend-only model route explicitly selects its configured default.');
  return lines.join("\n");
}
