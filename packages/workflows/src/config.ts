// Human renderers behind `agentprism-workflows config` (see ./cli.ts). The programmatic
// core — `probeHarnessConfig`, the `--models` view builders and the bounded authoring
// summary — lives in @automatalabs/acp-agents (`config-catalog.ts`) and is re-exported by
// this package's index; only the print boundary that depends on validate's table renderer
// stays here.

import {
  buildHarnessConfigSummary,
  formatHarnessConfigSummary,
  type HarnessConfigReport,
  type HarnessModelsView,
} from "@automatalabs/acp-agents";
import { renderHarnessOptionLines } from "./validate.js";

/** Render a HarnessConfigReport as the human-readable CLI output (validate's table format). */
export function formatHarnessConfigReport(report: HarnessConfigReport, options: { includeSummary?: boolean } = {}): string {
  const lines: string[] = ["advertised modes and config options:"];
  if (report.harnessOptions.length === 0) {
    lines.push("  (no harnesses requested)");
  } else {
    lines.push(...renderHarnessOptionLines(report.harnessOptions, "  "));
  }
  const probed = report.harnessOptions.filter((harness) => harness.probed).length;
  lines.push(`result: ${probed}/${report.harnessOptions.length} harness(es) probed`);
  if (options.includeSummary !== false) {
    lines.push(formatHarnessConfigSummary(report.authoringSummary ?? buildHarnessConfigSummary(report)));
  }
  return lines.join("\n");
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
