import { createHash } from "node:crypto";
import {
  type SessionConfigOption,
  type ValidateHarnessOptions,
  type ValidatedAgentCall,
  type WorkflowAgentConfiguration,
} from "@automatalabs/workflows";
import type { WorkflowMeta } from "@automatalabs/shared-types";

interface StringChoiceSchema {
  type: "string";
  title: string;
  description?: string;
  oneOf: Array<{ const: string; title: string }>;
}

interface BooleanSchema {
  type: "boolean";
  title: string;
  description?: string;
}

type FormProperty = StringChoiceSchema | BooleanSchema;

export interface WorkflowAgentConfigurationRequest {
  mode: "form";
  title: string;
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<string, FormProperty>;
    required: string[];
    additionalProperties: false;
  };
}

interface RouteChoice {
  value: string;
  title: string;
  harnessIndex: number;
}

interface SelectField {
  field: string;
  id: string;
  values: ReadonlySet<string>;
}

interface BooleanField {
  field: string;
  id: string;
}

interface HarnessFields {
  mode?: { field: string; values: ReadonlySet<string> };
  selects: SelectField[];
  booleans: BooleanField[];
}

interface CallFields {
  index: number;
  routeField: string;
  routes: ReadonlyMap<string, RouteChoice>;
  harnesses: ReadonlyMap<number, HarnessFields>;
}

export interface WorkflowAgentConfigurationPlan {
  request: WorkflowAgentConfigurationRequest;
  /** Binds modern multi-round-trip input to this exact discovered form/catalog. */
  selectionHash: string;
  callIndexes: number[];
  parse(content: Record<string, unknown>): Record<number, WorkflowAgentConfiguration>;
}

function phaseText(meta: WorkflowMeta, call: ValidatedAgentCall): { title: string; detail?: string } {
  const phase = meta.phases?.find((candidate) => candidate.title === call.phase);
  return {
    title: phase?.title ?? call.phase ?? "Unphased call",
    ...(phase?.detail ? { detail: phase.detail } : {}),
  };
}

function fieldDescription(meta: WorkflowMeta, call: ValidatedAgentCall, suffix?: string): string {
  const phase = phaseText(meta, call);
  const detail = phase.detail ? ` ${phase.detail}` : "";
  return `${phase.title}: ${call.label}.${detail} Task: ${call.promptPreview}${suffix ? ` ${suffix}` : ""}`.trim();
}

type SelectConfigOption = Extract<SessionConfigOption, { type: "select" }>;

function selectChoicePairs(option: SelectConfigOption): Array<{ value: string; label?: string }> {
  return [...new Map(
    option.options
      .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
      .map((entry) => [entry.value, { value: entry.value, label: entry.name }] as const),
  ).values()];
}

function modelOption(harness: ValidateHarnessOptions): SelectConfigOption | undefined {
  return harness.options?.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.type === "select" && option.id === "model",
  );
}

function routeChoices(harnesses: readonly ValidateHarnessOptions[]): RouteChoice[] {
  const choices: RouteChoice[] = [];
  const seen = new Set<string>();
  for (const [harnessIndex, harness] of harnesses.entries()) {
    if (!harness.probed) continue;
    const models = modelOption(harness);
    const pairs = models ? selectChoicePairs(models) : [];
    if (pairs.length === 0) {
      if (!seen.has(harness.backendId)) {
        seen.add(harness.backendId);
        choices.push({
          value: harness.backendId,
          title: `${harness.backendId} — harness default model`,
          harnessIndex,
        });
      }
      continue;
    }
    for (const choice of pairs) {
      const value = `${harness.backendId}/${choice.value}`;
      if (seen.has(value)) continue;
      seen.add(value);
      choices.push({
        value,
        title:
          `${harness.backendId} — ${choice.label ?? choice.value}` +
          (choice.value === models?.currentValue ? " (current)" : ""),
        harnessIndex,
      });
    }
  }
  return choices;
}

function optionDescription(option: SessionConfigOption): string | undefined {
  return typeof option.description === "string" && option.description.trim()
    ? option.description
    : undefined;
}

function buildHarnessFields(
  properties: Record<string, FormProperty>,
  meta: WorkflowMeta,
  call: ValidatedAgentCall,
  harness: ValidateHarnessOptions,
  harnessIndex: number,
): HarnessFields {
  const fields: HarnessFields = { selects: [], booleans: [] };
  const modes = harness.modes?.availableModes ?? [];
  if (modes.length > 0) {
    const field = `agent_${call.index}_provider_${harnessIndex}_mode`;
    const values = new Set(modes.map((mode) => mode.id));
    properties[field] = {
      type: "string",
      title: `Call ${call.index + 1} · ${harness.backendId} · mode`,
      description: fieldDescription(meta, call, `Applied only when ${harness.backendId} is selected.`),
      oneOf: modes.map((mode) => ({
        const: mode.id,
        title: `${mode.name}${mode.id === harness.modes?.currentModeId ? " (current)" : ""}`,
      })),
    };
    fields.mode = { field, values };
  }

  let optionIndex = 0;
  for (const option of harness.options ?? []) {
    if (option.id === "model") continue;
    const field = `agent_${call.index}_provider_${harnessIndex}_config_${optionIndex++}`;
    const description = [
      fieldDescription(meta, call, `Applied only when ${harness.backendId} is selected.`),
      optionDescription(option),
      option.type === "boolean" ? `Current: ${String(option.currentValue)}.` : undefined,
    ].filter(Boolean).join(" ");
    if (option.type === "boolean") {
      properties[field] = {
        type: "boolean",
        title: `Call ${call.index + 1} · ${harness.backendId} · ${option.name}`,
        ...(description ? { description } : {}),
      };
      fields.booleans.push({ field, id: option.id });
      continue;
    }
    const choices = selectChoicePairs(option);
    if (choices.length === 0) continue;
    properties[field] = {
      type: "string",
      title: `Call ${call.index + 1} · ${harness.backendId} · ${option.name}`,
      ...(description ? { description } : {}),
      oneOf: choices.map((choice) => ({
        const: choice.value,
        title:
          (choice.label ?? choice.value) +
          (choice.value === option.currentValue ? " (current)" : ""),
      })),
    };
    fields.selects.push({
      field,
      id: option.id,
      values: new Set(choices.map((choice) => choice.value)),
    });
  }
  return fields;
}

function unavailableSummary(harnesses: readonly ValidateHarnessOptions[]): string | undefined {
  const failed = harnesses.filter((harness) => !harness.probed);
  if (failed.length === 0) return undefined;
  const rendered = failed.slice(0, 4).map((harness) =>
    `${harness.backendId}: ${harness.error ?? "probe failed"}`
  );
  if (failed.length > rendered.length) rendered.push(`and ${failed.length - rendered.length} more`);
  return `Unavailable providers were omitted (${rendered.join("; ")}).`;
}

/**
 * Build one flat MCP form for every dry-run-observed agent call. MCP form schemas permit
 * primitive properties only, so provider-specific fields are prefixed per occurrence and
 * ignored unless that provider is selected for the call.
 */
export function buildWorkflowAgentConfigurationPlan(
  meta: WorkflowMeta,
  calls: readonly ValidatedAgentCall[],
  harnesses: readonly ValidateHarnessOptions[],
): WorkflowAgentConfigurationPlan | undefined {
  const configurableCalls = [...calls];
  if (configurableCalls.length === 0) return undefined;

  const routes = routeChoices(harnesses);
  if (routes.length === 0) {
    const errors = unavailableSummary(harnesses);
    throw new Error(
      "no provider/model configuration is available for the workflow's agent calls" +
        (errors ? `; ${errors}` : ""),
    );
  }

  const properties: Record<string, FormProperty> = {};
  const required: string[] = [];
  const callFields: CallFields[] = [];
  const callLines: string[] = [];

  for (const call of configurableCalls) {
    const phase = phaseText(meta, call);
    callLines.push(
      `${call.index + 1}. ${phase.title} — ${call.label}` +
        `${phase.detail ? `\n   ${phase.detail}` : ""}` +
        `\n   Task: ${call.promptPreview}`,
    );
    const routeField = `agent_${call.index}_model`;
    required.push(routeField);
    properties[routeField] = {
      type: "string",
      title: `Call ${call.index + 1} · provider/model`,
      description: fieldDescription(meta, call),
      oneOf: routes.map((route) => ({ const: route.value, title: route.title })),
    };

    const fieldsByHarness = new Map<number, HarnessFields>();
    for (const harnessIndex of new Set(routes.map((route) => route.harnessIndex))) {
      const harness = harnesses[harnessIndex];
      if (!harness) continue;
      fieldsByHarness.set(
        harnessIndex,
        buildHarnessFields(properties, meta, call, harness, harnessIndex),
      );
    }
    callFields.push({
      index: call.index,
      routeField,
      routes: new Map(routes.map((route) => [route.value, route])),
      harnesses: fieldsByHarness,
    });
  }

  const unavailable = unavailableSummary(harnesses);
  const request: WorkflowAgentConfigurationRequest = {
    mode: "form",
    title: "Configure workflow agents",
    message: [
      "Choose the provider and model for each agent call before execution.",
      "Optional provider fields are applied only when that provider is selected; leave them empty to use that provider's defaults.",
      "",
      ...callLines,
      ...(unavailable ? ["", unavailable] : []),
    ].join("\n"),
    requestedSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
  const selectionHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");

  return {
    request,
    selectionHash,
    callIndexes: configurableCalls.map((call) => call.index),
    parse(content) {
      const configurations: Record<number, WorkflowAgentConfiguration> = {};
      for (const call of callFields) {
        const selected = content[call.routeField];
        if (typeof selected !== "string") {
          throw new Error(`missing provider/model selection for agent occurrence ${call.index}`);
        }
        const route = call.routes.get(selected);
        if (!route) {
          throw new Error(`invalid provider/model selection for agent occurrence ${call.index}`);
        }
        const providerFields = call.harnesses.get(route.harnessIndex);
        const configuration: WorkflowAgentConfiguration = { model: route.value };
        if (providerFields?.mode) {
          const mode = content[providerFields.mode.field];
          if (mode !== undefined) {
            if (typeof mode !== "string" || !providerFields.mode.values.has(mode)) {
              throw new Error(`invalid mode selection for agent occurrence ${call.index}`);
            }
            configuration.mode = mode;
          }
        }
        const configEntries: Array<[string, string | boolean]> = [];
        for (const field of providerFields?.selects ?? []) {
          const value = content[field.field];
          if (value === undefined) continue;
          if (typeof value !== "string" || !field.values.has(value)) {
            throw new Error(`invalid ${field.id} selection for agent occurrence ${call.index}`);
          }
          configEntries.push([field.id, value]);
        }
        for (const field of providerFields?.booleans ?? []) {
          const value = content[field.field];
          if (value === undefined) continue;
          if (typeof value !== "boolean") {
            throw new Error(`invalid ${field.id} selection for agent occurrence ${call.index}`);
          }
          configEntries.push([field.id, value]);
        }
        if (configEntries.length > 0) configuration.configOptions = Object.fromEntries(configEntries);
        configurations[call.index] = configuration;
      }
      return configurations;
    },
  };
}
