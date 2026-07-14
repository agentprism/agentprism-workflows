#!/usr/bin/env node
// The @automatalabs/workflows bin (`agentprism-workflows`). One subcommand:
//
//   agentprism-workflows validate <workflow-file> [options]
//
// Validates a workflow script without spending tokens: static parse (meta literal,
// syntax, determinism blocklist), then a dry run over an in-process mock AgentRunner
// that fabricates schema-conforming results — no ACP process is spawned. See
// ./validate.ts for the programmatic API (`validateWorkflowScript`).

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openWorkflowDir } from "@automatalabs/workflow-engine";
import { validateWorkflowScript, formatValidateReport } from "./validate.js";
import type { ValidateWorkflowOptions } from "./validate.js";

const USAGE = `Usage: agentprism-workflows validate <workflow-file-or-name> [options]

Validates an AgentPrism workflow script without spending tokens:
  1. static parse — the meta literal, syntax, and the determinism blocklist
  2. dry run — the script executes against a mock agent backend that fabricates
     schema-conforming results; no ACP process is spawned, no tokens are spent,
     and a mock live confirm resolves checkpoints to their declared defaults

Options:
  --args <json>          the script's \`args\` global for the dry run (a JSON value)
  --args-file <path>     read the args JSON from a file instead
  --mock-answers <json>       label-glob mock answers for dry-run agent calls
  --mock-answers-file <path>  read the label-glob mock answers JSON from a UTF-8 file
  --workflows-dir <dir>  a directory of workflow scripts (repeatable; precedence in
                         the order given). Enables validating by NAME (filename stem)
                         and resolves nested workflow("<name>") calls in the dry run
  --parse-only           static parse only; skip the dry run
  --cwd <dir>            base cwd for the dry run (default: a throwaway temp dir;
                         point it at a real repo only if you want worktree isolation
                         to create — and clean up — real git worktrees)
  --token-budget <n>     set budget.total so budget-guarded paths execute
                         (the mock backend reports 1000 tokens per agent call)
  --max-agents <n>       cap dry-run agent calls
  --timeout-ms <n>       dry-run wall-clock limit (default 30000)
  --json                 print the machine-readable report to stdout
  -h, --help             show this help

Notes:
  - without --workflows-dir, nested workflow("<saved-name>") calls fail in the dry
    run (no saved-workflow resolver); nested INLINE script strings always validate
  - script-declared meta.backends are treated as approved for the dry run, but the
    report reminds you that real runs require explicit approval

Exit codes: 0 valid · 1 parse/static failure · 2 dry-run failure · 3 usage error`;

function fail(message: string): never {
  writeFileSync(process.stderr.fd, `${message}\n\nRun \`agentprism-workflows validate --help\` for usage.\n`);
  process.exit(3);
}

function parseIntFlag(name: string, raw: string | undefined): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value) || value <= 0) fail(`${name} expects a positive number`);
  return Math.floor(value);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(command === undefined ? 3 : 0);
  }
  if (command !== "validate") fail(`unknown command "${command}" — the only command is: validate`);

  let file: string | undefined;
  let json = false;
  let mockAnswersFlag: "--mock-answers" | "--mock-answers-file" | undefined;
  const workflowDirs: string[] = [];
  const options: ValidateWorkflowOptions = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
        break;
      case "--json":
        json = true;
        break;
      case "--parse-only":
        options.dryRun = false;
        break;
      case "--args":
        try {
          options.args = JSON.parse(rest[++i] ?? "");
        } catch {
          fail("--args expects a JSON value (quote it for your shell)");
        }
        break;
      case "--args-file":
        try {
          options.args = JSON.parse(readFileSync(resolve(rest[++i] ?? ""), "utf8"));
        } catch (error) {
          fail(`--args-file: ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      case "--mock-answers": {
        if (mockAnswersFlag === arg) fail(`${arg} may appear at most once`);
        if (mockAnswersFlag) fail("--mock-answers and --mock-answers-file are mutually exclusive");
        mockAnswersFlag = arg;
        const source = rest[++i];
        if (source === undefined) fail("--mock-answers expects a JSON object (quote it for your shell)");
        if (Buffer.byteLength(source, "utf8") > 256 * 1024) fail("--mock-answers exceeds the 256 KiB source limit");
        try {
          options.mockAnswers = JSON.parse(source);
        } catch {
          fail("--mock-answers expects a JSON object (quote it for your shell)");
        }
        break;
      }
      case "--mock-answers-file": {
        if (mockAnswersFlag === arg) fail(`${arg} may appear at most once`);
        if (mockAnswersFlag) fail("--mock-answers and --mock-answers-file are mutually exclusive");
        mockAnswersFlag = arg;
        const rawPath = rest[++i];
        if (rawPath === undefined) fail("--mock-answers-file expects a path");
        const path = resolve(rawPath);
        try {
          if (statSync(path).size > 256 * 1024) fail("--mock-answers-file exceeds the 256 KiB source limit");
          options.mockAnswers = JSON.parse(readFileSync(path, "utf8"));
        } catch (error) {
          if (error instanceof SyntaxError) fail(`--mock-answers-file: ${error.message}`);
          fail(`--mock-answers-file: ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }
      case "--workflows-dir":
        workflowDirs.push(resolve(rest[++i] ?? fail("--workflows-dir expects a directory")));
        break;
      case "--cwd":
        options.cwd = resolve(rest[++i] ?? fail("--cwd expects a directory"));
        break;
      case "--token-budget":
        options.tokenBudget = parseIntFlag("--token-budget", rest[++i]);
        break;
      case "--max-agents":
        options.maxAgents = parseIntFlag("--max-agents", rest[++i]);
        break;
      case "--timeout-ms":
        options.timeoutMs = parseIntFlag("--timeout-ms", rest[++i]);
        break;
      default:
        if (arg.startsWith("-")) fail(`unknown option "${arg}"`);
        if (file !== undefined) fail("exactly one workflow file expected");
        file = arg;
    }
  }

  if (file === undefined) fail("missing <workflow-file-or-name>");
  const flows = workflowDirs.length > 0 ? openWorkflowDir(workflowDirs) : undefined;
  if (flows) options.workflows = flows;

  // The positional is a file path first; with --workflows-dir it may also be a NAME.
  let script: string;
  if (existsSync(resolve(file))) {
    try {
      script = readFileSync(resolve(file), "utf8");
    } catch (error) {
      fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (flows) {
    try {
      script = flows.read(file); // throws with searched dirs + closest matches
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  } else {
    fail(`cannot read ${file}: no such file (pass --workflows-dir to validate by name)`);
  }

  let report;
  try {
    report = await validateWorkflowScript(script, options);
  } catch (error) {
    if (mockAnswersFlag && error instanceof TypeError) {
      fail(`${mockAnswersFlag}: ${error.message}`);
    }
    throw error;
  }
  writeFileSync(
    process.stdout.fd,
    json ? `${JSON.stringify(report, null, 2)}\n` : `${formatValidateReport(report)}\n`,
  );
  process.exitCode = report.exitCode;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`validate crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(3);
});
