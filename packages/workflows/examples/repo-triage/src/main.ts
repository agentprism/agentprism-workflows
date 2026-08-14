#!/usr/bin/env node
// Host program for the repo-triage example: load a workflow script FILE by name
// through the @automatalabs/workflows SDK, run it unattended against a target
// repository, and print the structured result.
//
//   npm start                              # triage the nearest enclosing git repo
//   npm start -- --target /path/to/repo    # triage a specific checkout
//   npm start -- --workflow quick-wins     # run the nested hunter standalone
//
// Flags:
//   --target <dir>             repo to triage (default: nearest enclosing git repo)
//   --workflow <name>          which saved workflow to run (default: repo-triage)
//
//   --max-areas <n>            areas the map step may pick (default: 4)
//   --findings-per-area <n>    per-area findings cap (default: 3)
//   --hunt-rounds <n>          quick-wins rounds; 0 disables the Hunt stage (default: 3)
//   --focus "<text>"           what to triage for (default: see the workflow script)
//   --out <file.md>            where to write the gated report (default: ./triage-report.md)

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkflowDir, runDynamicWorkflow } from "@automatalabs/workflows";
import type { WorkflowSnapshot } from "@automatalabs/workflows";

const exampleDir = dirname(dirname(fileURLToPath(import.meta.url)));

// ── flags ──
const flags = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith("--")) continue;
  const next = argv[i + 1];
  // A flag given without a value (last arg, or followed by another flag) is stored as
  // "" and treated everywhere below as "not provided".
  if (next !== undefined && !next.startsWith("--")) {
    flags.set(arg.slice(2), next);
    i++;
  } else {
    flags.set(arg.slice(2), "");
  }
}
const num = (name: string, fallback: number): number => {
  const raw = flags.get(name);
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
};

// Default target: the nearest enclosing git repo of this example. Inside the
// agentprism-workflows checkout that is the monorepo root; with this folder copied
// out into your own project, it is YOUR repo.
function defaultTarget(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: exampleDir, encoding: "utf8" }).trim();
  } catch {
    return exampleDir;
  }
}
const target = resolve(flags.get("target") || defaultTarget());
const workflowName = flags.get("workflow") || "repo-triage";
// The token budget is deleted (§7): an autonomous triage should finish, not die at
// an arbitrary cap.
const outFile = resolve(flags.get("out") || resolve(exampleDir, "triage-report.md"));

// The SDK's workflow loader: a fresh-per-call view over ./workflows/*.workflow.js
// (filename stem = workflow name). Handing the view to runDynamicWorkflow makes the
// first argument a NAME instead of script source, and lets the script's own nested
// `workflow("quick-wins")` call resolve from the same folder.
const flows = openWorkflowDir(resolve(exampleDir, "workflows"));
const available = flows.list().map((w) => w.name);
if (!available.includes(workflowName)) {
  console.error(`unknown workflow "${workflowName}" — available: ${available.join(", ")}`);
  process.exit(1);
}

console.error(`running "${workflowName}" against ${target}`);

// ── the run ──
let lastLine = "";
const run = await runDynamicWorkflow(workflowName, {
  workflows: flows,
  // Every agent session runs at the target repo; the script reads it as `cwd`.
  cwd: target,
  // The script's `args` global. Undefined knobs fall back to the script's defaults.
  args: {
    focus: flags.get("focus"),
    maxAreas: num("max-areas", 4),
    findingsPerArea: num("findings-per-area", 3),
    huntRounds: num("hunt-rounds", 3),
    rounds: num("hunt-rounds", 3), // quick-wins' round cap, when run standalone
  },
  exec: {
    agentTimeoutMs: 600_000, // no single agent may run longer than 10 minutes
    agentRetries: 1, // default retry for recoverable failures (timeouts, empty output)
    onProgress: (s: WorkflowSnapshot) => {
      const running = s.agents.filter((a) => a.status === "running").map((a) => a.label).join(", ");
      const line = `[${s.currentPhase ?? "…"}] ${s.doneCount}/${s.agentCount} agents done${running ? ` — running: ${running}` : ""}`;
      if (line !== lastLine) console.error((lastLine = line));
    },
  },
});

// ── the result ──
console.log(`\nstatus:  ${run.status}${run.reason ? ` (${run.reason})` : ""}`);
console.log(`phases:  ${run.phases.join(" → ")}`);
console.log(`agents:  ${run.agentCount} calls in ${Math.round(run.durationMs / 1000)}s`);
if (run.tokenUsage)
  console.log(`tokens:  ${run.tokenUsage.total.toLocaleString()}`);
if (run.logs.length > 0) console.log(`log:\n  ${run.logs.join("\n  ")}`);

if (run.status !== "completed") {
  // A paused run (provider quota wall, backend auth) is resumable from its journal —
  // see "Durable runs" in the @automatalabs/workflows README.
  if (run.resetHint) console.error(`usage-limit pause — ${run.resetHint}`);
  if (run.authContext) console.error(`authentication required for backend "${run.authContext.backendId}"`);
  console.error(`run ${run.runId} did not complete`);
  process.exitCode = 1;
} else {
  interface Finding {
    severity: string;
    file: string;
    line: number;
    summary: string;
    foundBy: string;
    verifiedBy: string[];
  }
  interface QuickWin {
    file: string;
    summary: string;
    action: string;
    foundBy?: string;
  }
  const result = (run.result ?? {}) as {
    stats?: Record<string, number | boolean>;
    findings?: Finding[];
    unverified?: Finding[];
    quickWins?: QuickWin[];
    wins?: QuickWin[]; // quick-wins standalone
    report?: string | null;
    completeness?: { complete: boolean; missing?: string[] } | null;
  };

  if (result.stats) console.log(`stats:   ${JSON.stringify(result.stats)}`);
  for (const f of result.findings ?? []) {
    console.log(`  [${f.severity}] ${f.file}:${f.line} — ${f.summary} (${f.foundBy} → ${f.verifiedBy.join("+")})`);
  }
  for (const f of result.unverified ?? []) {
    console.log(`  [unverified] ${f.file}:${f.line} — ${f.summary} (${f.foundBy}; no juror responded)`);
  }
  for (const w of result.quickWins ?? result.wins ?? []) {
    console.log(`  [win] ${w.file} — ${w.summary} → ${w.action}${w.foundBy ? ` (${w.foundBy})` : ""}`);
  }
  if (result.completeness && !result.completeness.complete) {
    console.log(`not covered: ${(result.completeness.missing ?? []).join("; ")}`);
  }
  if (typeof result.report === "string" && result.report.length > 0) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, result.report);
    console.log(`report:  ${outFile}`);
  }
  process.exitCode = 0;
}
