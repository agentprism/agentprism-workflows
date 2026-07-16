#!/usr/bin/env node
// The @automatalabs/workflows bin (`agentprism-workflows`). Two subcommands:
//
//   agentprism-workflows validate <workflow-file> [options]
//   agentprism-workflows config [harness ...] [options]
//
// validate checks a workflow script without spending tokens: static parse (meta literal,
// syntax, direct nondeterministic call expressions), then a dry run over an in-process
// mock AgentRunner that fabricates schema-conforming results, then one no-prompt option
// probe per routed ACP harness. See
// ./validate.ts for the programmatic API (`validateWorkflowScript`).
//
// config runs that same no-prompt probe standalone — no script needed — and prints each
// requested harness's advertised config-option catalog (model ids, effort levels, modes,
// …). See ./config.ts for the programmatic API (`probeHarnessConfig`).

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openWorkflowDir } from "@automatalabs/workflow-engine";
import { validateWorkflowScript, formatValidateReport } from "./validate.js";
import type { ValidateWorkflowOptions } from "./validate.js";
import { probeHarnessConfig, formatHarnessConfigReport } from "./config.js";
import type { ProbeHarnessConfigOptions } from "./config.js";

const ROOT_USAGE = `Usage: agentprism-workflows <command> …

Commands:
  validate <workflow-file-or-name>  validate a workflow script without spending tokens
                                    (static parse + mock dry run + harness config probe)
  config [harness ...]              print each ACP harness's advertised config-option
                                    catalog (model ids, effort levels, modes, …) so
                                    model/configOptions values come from the live
                                    catalog, not guesswork

Run \`agentprism-workflows <command> --help\` for that command's options.`;

const USAGE = `Usage: agentprism-workflows validate <workflow-file-or-name> [options]

Validates an AgentPrism workflow script without spending tokens:
  1. static parse — the meta literal, syntax, and direct nondeterministic call
     expressions
  2. dry run — the script executes against a mock agent backend that fabricates
     schema-conforming results; no tokens are spent, and a mock live confirm
     resolves checkpoints to their declared defaults
  3. config probe — each routed ACP harness opens once with no prompt; advertised
     options are reported and authored configOptions are checked. Probe failures warn
     and skip that harness's checks without making validation fail

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

const CONFIG_USAGE = `Usage: agentprism-workflows config [harness ...] [options]

Prints each requested ACP harness's advertised, negotiable session config-option
catalog — model ids (including bracket variants like opus[1m]), effort levels, modes,
and every other session option — by opening one no-prompt session per harness. Zero
tokens. Run this BEFORE authoring a workflow so \`model\` / \`configOptions\` values come
from the live catalog instead of guesswork (or a throwaway probe workflow).

Harnesses: the built-in names (claude, codex, opencode) and any custom backend
registered via the AGENTPRISM_BACKENDS env var. Default: all of them. A harness that
cannot spawn or authenticate reports \`probed: false\` with the reason and never blocks
the others.

Options:
  --cwd <dir>         session cwd for the probes (default: the current directory —
                      harnesses may resolve project-level config, and hence their
                      catalog, from it)
  --timeout-ms <n>    per-harness probe bound in milliseconds (default 60000); a
                      timed-out harness reports probed:false
  --json              print the machine-readable report to stdout
  -h, --help          show this help

Exit codes: 0 all probed · 1 at least one probe failed · 3 usage error`;

let activeCommand = "";

function fail(message: string): never {
  const hint = activeCommand === "" ? "agentprism-workflows --help" : `agentprism-workflows ${activeCommand} --help`;
  writeFileSync(process.stderr.fd, `${message}\n\nRun \`${hint}\` for usage.\n`);
  process.exit(3);
}

function parseIntFlag(name: string, raw: string | undefined): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value) || value <= 0) fail(`${name} expects a positive number`);
  return Math.floor(value);
}

async function mainConfig(rest: string[]): Promise<void> {
  let json = false;
  const harnesses: string[] = [];
  const options: ProbeHarnessConfigOptions = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(`${CONFIG_USAGE}\n`);
        process.exit(0);
        break;
      case "--json":
        json = true;
        break;
      case "--cwd":
        options.cwd = resolve(rest[++i] ?? fail("--cwd expects a directory"));
        break;
      case "--timeout-ms":
        options.timeoutMs = parseIntFlag("--timeout-ms", rest[++i]);
        break;
      default:
        if (arg.startsWith("-")) fail(`unknown option "${arg}"`);
        harnesses.push(arg);
    }
  }

  if (harnesses.length > 0) options.harnesses = harnesses;
  // A malformed AGENTPRISM_BACKENDS registry throws here — that is a configuration
  // error (usage exit), not a probe outcome.
  let report;
  try {
    report = await probeHarnessConfig(options);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  writeFileSync(
    process.stdout.fd,
    json ? `${JSON.stringify(report, null, 2)}\n` : `${formatHarnessConfigReport(report)}\n`,
  );
  process.exitCode = report.exitCode;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help") {
    process.stdout.write(`${ROOT_USAGE}\n`);
    process.exit(command === undefined ? 3 : 0);
  }
  if (command === "config") {
    activeCommand = "config";
    return mainConfig(rest);
  }
  if (command !== "validate") fail(`unknown command "${command}" — the commands are: validate, config`);
  activeCommand = "validate";

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
  const command = activeCommand === "" ? "agentprism-workflows" : activeCommand;
  process.stderr.write(`${command} crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(3);
});
