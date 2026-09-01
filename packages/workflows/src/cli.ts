#!/usr/bin/env node
// The @automatalabs/workflows bin (`agentprism-workflows`). Three subcommands:
//
//   agentprism-workflows validate <workflow-file> [options]
//   agentprism-workflows config [harness ...] [options]
//   agentprism-workflows mcp
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
//
// mcp delegates stdio unchanged to the MCP server embedded at build time. In a source
// checkout without that bundle, it falls back to the separately built mcp-server entry.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { openWorkflowDir } from "@automatalabs/workflow-engine";
import { validateWorkflowScript, formatValidateReport, collapseHarnessOptionsForOutput } from "./validate.js";
import type { ValidateWorkflowOptions } from "./validate.js";
import {
  probeHarnessConfig,
  formatHarnessConfigReport,
  buildHarnessModelsView,
  formatHarnessModels,
} from "./config.js";
import type { ProbeHarnessConfigOptions } from "./config.js";

const ROOT_USAGE = `Usage: agentprism-workflows <command> …

Commands:
  validate <workflow-file-or-name>  validate a workflow script without spending tokens
                                    (static parse + mock dry run + harness config probe)
  config [harness ...]              print each ACP harness's advertised config-option
                                    catalog (model ids, effort levels, modes, …) so
                                    model/configOptions values come from the live
                                    catalog, not guesswork
  mcp                               launch the AgentPrism MCP stdio entry (a thin proxy
                                    to the shared local workflow daemon, auto-started;
                                    --in-process restores the old single-process server)
  daemon <start|stop|status|url|run|logs>
                                    manage the shared local workflow daemon

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

Harnesses: the built-in names (claude, codex, opencode, pi) and any custom backend
registered via the AGENTPRISM_BACKENDS env var. Default: all of them. A harness that
cannot spawn or authenticate reports \`probed: false\` with the reason and never blocks
the others.

A harness with a large model catalog (pi, opencode) has its \`model\` choices collapsed
to a grouped summary in BOTH the default table and \`--json\`, so the full list never
floods context on either surface. Reach the leaves explicitly with --models:

  config <harness> --models              provider/group breakdown + counts (no leaf ids)
  config <harness> --models=<filter>     the leaf model ids matching <filter>, where
                                         <filter> is a provider/substring or /regex/

Options:
  --cwd <dir>         session cwd for the probes (default: the current directory —
                      harnesses may resolve project-level config, and hence their
                      catalog, from it)
  --models[=<filter>] list a harness's model catalog: bare = provider/group breakdown;
                      =<provider|substring|/regex/> = the matching leaf ids. There is no
                      unfiltered full-leaf dump on any surface
  --json              print the machine-readable report to stdout (oversized model
                      catalogs are summarized here too; --models with --json emits the
                      structured model view)
  -h, --help          show this help

Exit codes: 0 all probed · 1 at least one probe failed · 3 usage error`;

const MCP_USAGE = `Usage: agentprism-workflows mcp [options]

Launches the AgentPrism MCP stdio entry. By default this is a thin shim that proxies
stdio to the shared local workflow daemon (Streamable HTTP on loopback), auto-starting
the daemon when none is running — so workflow runs survive this process being killed by
the MCP client. stdin and stdout are reserved for JSON-RPC framing.

Options:
  --in-process         serve MCP over stdio in this process tree (the pre-daemon
                       behavior: runs die with the process)
  --port <n>           daemon port to use/spawn (default: 29888, or
                       AGENTPRISM_DAEMON_PORT)
  -h, --help           show this help

Each workflow run names its project via the required \`projectDir\` tool argument, so one
registration serves every project.`;

const DAEMON_USAGE = `Usage: agentprism-workflows daemon <command>

Manage the shared local workflow daemon (the process that actually executes workflow
runs; MCP clients reach it via the stdio shim or directly over Streamable HTTP).

Commands:
  start            start the daemon in the background (no-op when already running)
  stop             stop the running daemon (SIGTERM, waits for exit)
  status           show pid, port, version, uptime, sessions, and active runs
  url              print the MCP endpoint URL and client registration snippets
  run              run the daemon in the foreground (logs to stderr)
  logs [-n LINES]  print the tail of the daemon log`;

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
  let modelsMode = false;
  let modelsFilter: string | undefined;
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
      case "--models":
        modelsMode = true;
        break;
      case "--cwd":
        options.cwd = resolve(rest[++i] ?? fail("--cwd expects a directory"));
        break;
      default:
        if (arg.startsWith("--models=")) {
          modelsMode = true;
          modelsFilter = arg.slice("--models=".length);
          break;
        }
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

  if (modelsMode) {
    let views;
    try {
      views = buildHarnessModelsView(report, modelsFilter); // invalid --models regex fails here
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    writeFileSync(
      process.stdout.fd,
      json ? `${JSON.stringify({ harnessModels: views }, null, 2)}\n` : `${formatHarnessModels(views)}\n`,
    );
    process.exitCode = report.exitCode;
    return;
  }

  // The complete catalog stays in `report`; collapse oversized selects only for the
  // serialized (--json) surface so it cannot flood context any more than the human table.
  const jsonReport = { ...report, harnessOptions: collapseHarnessOptionsForOutput(report.harnessOptions) };
  writeFileSync(
    process.stdout.fd,
    json ? `${JSON.stringify(jsonReport, null, 2)}\n` : `${formatHarnessConfigReport(report)}\n`,
  );
  process.exitCode = report.exitCode;
}

function resolveServerPath(): string {
  const bundlePath = resolve(import.meta.dirname, "mcp-server.js");
  const monorepoFallbackPath = resolve(import.meta.dirname, "../../mcp-server/dist/cli.js");
  const serverPath = existsSync(bundlePath)
    ? bundlePath
    : existsSync(monorepoFallbackPath)
      ? monorepoFallbackPath
      : undefined;

  if (serverPath === undefined) {
    fail(
      `MCP server bundle not found at ${bundlePath}, and the monorepo fallback is not built. ` +
        "Run `pnpm --filter @automatalabs/workflows build` to create the bundle, or run `pnpm build` at the repository root.",
    );
  }
  return serverPath;
}

async function mainMcp(rest: string[]): Promise<void> {
  const forwarded: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(`${MCP_USAGE}\n`);
        process.exit(0);
        break;
      case "--in-process":
        forwarded.push(arg);
        break;
      case "--port": {
        const value = rest[++i];
        if (value === undefined) fail(`${arg} expects a value`);
        forwarded.push(arg, value);
        break;
      }
      default:
        fail(`unknown option "${arg}"`);
    }
  }

  await spawnServer(resolveServerPath(), forwarded);
}

async function mainDaemon(rest: string[]): Promise<void> {
  if (rest.length === 0 || rest[0] === "-h" || rest[0] === "--help") {
    process.stdout.write(`${DAEMON_USAGE}\n`);
    process.exit(rest.length === 0 ? 3 : 0);
  }
  await spawnServer(resolveServerPath(), ["daemon", ...rest]);
}

async function spawnServer(serverPath: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const child = spawn(process.execPath, [serverPath, ...args], { stdio: "inherit" });
    const forwardedSignals = ["SIGINT", "SIGTERM"] as const;
    let settled = false;
    let cleaned = false;

    const forwarders = new Map<(typeof forwardedSignals)[number], () => void>();
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      for (const [signal, forward] of forwarders) process.off(signal, forward);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
      resolvePromise();
    };
    const onError = (error: Error) => {
      finish(() => {
        process.stderr.write(`mcp server failed to start: ${error.message}\n`);
        process.exitCode = 1;
      });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() => {
        if (signal === null) {
          process.exitCode = code ?? 1;
          return;
        }

        // Preserve signal termination for callers (shells, npx, and MCP hosts). Set a
        // conventional nonzero fallback first in case re-raising is unsupported here.
        process.exitCode = 128 + (osConstants.signals[signal] ?? 1);
        try {
          process.kill(process.pid, signal);
        } catch (error) {
          process.stderr.write(
            `mcp server exited on ${signal}, but the parent could not re-raise it: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      });
    };

    for (const signal of forwardedSignals) {
      const forward = () => {
        try {
          child.kill(signal);
        } catch (error) {
          process.stderr.write(
            `could not forward ${signal} to the mcp server: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      };
      forwarders.set(signal, forward);
      process.on(signal, forward);
    }
    child.once("error", onError);
    child.once("exit", onExit);
  });
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
  if (command === "mcp") {
    activeCommand = "mcp";
    return mainMcp(rest);
  }
  if (command === "daemon") {
    activeCommand = "daemon";
    return mainDaemon(rest);
  }
  if (command !== "validate") fail(`unknown command "${command}" — the commands are: validate, config, mcp, daemon`);
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
  // Collapse oversized harness catalogs only in the serialized report — the human render
  // already summarizes them, and the complete catalog stays in `report` for its own checks.
  const jsonReport =
    report.dryRun?.harnessOptions === undefined
      ? report
      : {
          ...report,
          dryRun: {
            ...report.dryRun,
            harnessOptions: collapseHarnessOptionsForOutput(report.dryRun.harnessOptions),
          },
        };
  writeFileSync(
    process.stdout.fd,
    json ? `${JSON.stringify(jsonReport, null, 2)}\n` : `${formatValidateReport(report)}\n`,
  );
  process.exitCode = report.exitCode;
}

main(process.argv.slice(2)).catch((error) => {
  const command = activeCommand === "" ? "agentprism-workflows" : activeCommand;
  process.stderr.write(`${command} crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(3);
});
