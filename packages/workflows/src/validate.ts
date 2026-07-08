// Token-free validation for workflow scripts: a static parse (meta literal, syntax,
// determinism blocklist) followed by an optional DRY RUN — the script executes for real
// in the engine's deterministic realm, but every agent() call is served by an in-process
// mock AgentRunner that fabricates schema-conforming results. No ACP process is spawned,
// no tokens are spent, checkpoints resolve to their headless defaults, and run state is
// journaled nowhere (journaling off + a throwaway persistence root for the run lease).
//
// This is the programmatic core behind `agentprism-workflows validate` (see ./cli.ts).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkflowDir, WorkflowManager, parseWorkflowScript } from "@automatalabs/workflow-engine";
import { resolveBackendRegistry, selectBackend } from "@automatalabs/acp-agents";
import type { CustomBackendConfig } from "@automatalabs/acp-agents";
import type { WorkflowDir } from "@automatalabs/workflow-engine";
import type { AgentRunner, AgentUsage, WorkflowMeta } from "@automatalabs/shared-types";

export interface ValidateWorkflowOptions {
  /** The `args` global handed to the script during the dry run. */
  args?: unknown;
  /** A workflow directory view (or dir path(s)) serving saved workflows by name, so
   *  nested `workflow("<name>")` calls resolve during the dry run instead of failing. */
  workflows?: string | string[] | WorkflowDir;
  /** Base cwd for the dry run. Default: a throwaway temp dir (so `isolation: "worktree"`
   *  degrades to a no-op instead of creating real worktrees in a repo). */
  cwd?: string;
  /** false => static parse only, no dry run. Default true. */
  dryRun?: boolean;
  /** Set budget.total for the dry run so budget-guarded paths execute. The mock runner
   *  reports 1000 tokens per agent call. */
  tokenBudget?: number;
  /** Cap on dry-run agent calls (defaults to the engine's own cap). */
  maxAgents?: number;
  /** Dry-run wall-clock limit. Default 30_000 ms. */
  timeoutMs?: number;
}

/** One agent() call observed during the dry run, with its backend attribution. */
export interface ValidatedAgentCall {
  label: string;
  phase?: string;
  /** The model spec the call requested (undefined = the run/session default). */
  model?: string;
  tier?: string;
  mode?: string;
  /** Which backend the spec routes to: "claude" | "codex" | "opencode" | a custom backend
   *  name (suffixed " (script-declared)" when it comes from meta.backends) | "default". */
  backend: string;
  /** True when the call requested structured output. */
  schema: boolean;
}

export interface ValidatedCheckpoint {
  prompt: string;
  kind: string;
  /** The reply the dry run took (the checkpoint's headless default). */
  reply: unknown;
}

export interface ValidateWorkflowReport {
  /** True when the parse succeeded AND the dry run (if performed) completed. */
  ok: boolean;
  /** 0 = valid; 1 = parse/static failure; 2 = dry-run failure. */
  exitCode: 0 | 1 | 2;
  parse: {
    ok: boolean;
    error?: string;
    meta?: WorkflowMeta;
  };
  dryRun?: {
    ok: boolean;
    status: string;
    reason?: string;
    /** True when the run was cut off by ValidateWorkflowOptions.timeoutMs. */
    timedOut: boolean;
    agentCalls: ValidatedAgentCall[];
    checkpoints: ValidatedCheckpoint[];
    phasesVisited: string[];
    logs: string[];
    durationMs: number;
    /** The script's return value, composed from fabricated agent results. */
    result?: unknown;
  };
  warnings: string[];
}

/**
 * Fabricate a value that structurally satisfies a JSON Schema — the dry run's stand-in
 * for a real agent's structured output. Deterministic and intentionally simple: first
 * enum/anyOf variant, `true` booleans (so ok-gates terminate), `mock-<field>` strings.
 */
export function fabricateFromSchema(schema: unknown, hint = "value", depth = 0): unknown {
  if (depth > 16) return null;
  if (!schema || typeof schema !== "object") return `mock-${hint}`;
  const s = schema as Record<string, unknown>;
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  if (s.default !== undefined) return s.default;
  const variants = s.anyOf ?? s.oneOf ?? s.allOf;
  if (Array.isArray(variants) && variants.length > 0) return fabricateFromSchema(variants[0], hint, depth + 1);

  let type = s.type;
  if (Array.isArray(type)) type = type[0];
  if (type === undefined) {
    if (s.properties) type = "object";
    else if (s.items) type = "array";
    else return `mock-${hint}`;
  }

  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = (s.properties ?? {}) as Record<string, unknown>;
      for (const [name, sub] of Object.entries(props)) out[name] = fabricateFromSchema(sub, name, depth + 1);
      for (const name of Array.isArray(s.required) ? (s.required as string[]) : []) {
        if (!(name in out)) out[name] = `mock-${name}`;
      }
      return out;
    }
    case "array": {
      const min = typeof s.minItems === "number" ? s.minItems : 1;
      const count = Math.min(Math.max(min, 1), 3);
      return Array.from({ length: count }, (_x, i) => fabricateFromSchema(s.items, `${hint}-${i + 1}`, depth + 1));
    }
    case "string": {
      if (s.format === "uri" || s.format === "url") return "https://example.invalid/mock";
      if (s.format === "date-time") return "2024-01-01T00:00:00Z";
      if (s.format === "date") return "2024-01-01";
      let value = `mock-${hint}`;
      if (typeof s.minLength === "number" && value.length < s.minLength) {
        value = value.padEnd(s.minLength, "x");
      }
      if (typeof s.maxLength === "number" && value.length > s.maxLength) {
        value = value.slice(0, s.maxLength);
      }
      return value;
    }
    case "integer":
    case "number": {
      if (typeof s.minimum === "number") return s.minimum;
      if (typeof s.maximum === "number" && (s.maximum as number) < 1) return s.maximum;
      return 1;
    }
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return `mock-${hint}`;
  }
}

/** The RunOptions fields the mock runner reads. The engine binds the seam's frozen field
 *  names through a cast (see shared-types RunOptions), mirrored here to keep this module
 *  free of the typebox generic plumbing. */
interface MockRunOptions {
  label?: string;
  model?: string;
  tier?: string;
  mode?: string;
  schema?: unknown;
  onUsage?: (usage: AgentUsage) => void;
}

/** Tokens the mock runner reports per agent call, so `--token-budget` exercises
 *  budget-guarded script paths deterministically. */
export const MOCK_TOKENS_PER_AGENT = 1000;

function attributeBackend(
  model: string | undefined,
  tier: string | undefined,
  declared: Record<string, unknown> | undefined,
): string {
  const spec = model ?? tier;
  if (!spec) return "default";
  const head = spec.split("/")[0].replace(/\[[^\]]*\]\s*$/, "").trim().toLowerCase();
  if (declared && Object.keys(declared).some((name) => name.toLowerCase() === head)) {
    return `${head} (script-declared)`;
  }
  try {
    const registry = resolveBackendRegistry(declared as Record<string, CustomBackendConfig> | undefined);
    return selectBackend({ model, tier }, registry).id;
  } catch {
    return "default";
  }
}

/**
 * Validate a workflow script: parse it, then (by default) dry-run it against a mock
 * AgentRunner. Never throws for an invalid script — read `report.ok` / `report.exitCode`.
 */
export async function validateWorkflowScript(
  script: string,
  options: ValidateWorkflowOptions = {},
): Promise<ValidateWorkflowReport> {
  const warnings: string[] = [];

  let meta: WorkflowMeta;
  try {
    meta = parseWorkflowScript(script).meta;
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      parse: { ok: false, error: error instanceof Error ? error.message : String(error) },
      warnings,
    };
  }

  const declaredBackends = meta.backends && Object.keys(meta.backends).length > 0 ? meta.backends : undefined;
  if (declaredBackends) {
    warnings.push(
      `script declares custom backends (${Object.keys(declaredBackends).join(", ")}) — real runs must approve them ` +
        `(allowScriptBackends / exec.scriptBackends / AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1); the dry run treats them as approved`,
    );
  }

  if (options.dryRun === false) {
    return { ok: true, exitCode: 0, parse: { ok: true, meta }, warnings };
  }

  // Throwaway directories: the run cwd (unless the caller pins one) so worktree isolation
  // no-ops, and a private persistence root so the run lease never touches the real store.
  const ownedCwd = options.cwd === undefined;
  const baseCwd = options.cwd ?? mkdtempSync(join(tmpdir(), "agentprism-validate-"));
  const persistenceRoot = mkdtempSync(join(tmpdir(), "agentprism-validate-state-"));

  const mockMeta = new Map<string, { tier?: string; mode?: string; schema: boolean }>();
  const runner = {
    async run(_prompt: string, runOptions: MockRunOptions = {}) {
      const label = runOptions.label ?? "";
      mockMeta.set(label, {
        tier: runOptions.tier,
        mode: runOptions.mode,
        schema: runOptions.schema !== undefined,
      });
      runOptions.onUsage?.({
        input: MOCK_TOKENS_PER_AGENT - 250,
        output: 250,
        cacheRead: 0,
        cacheWrite: 0,
        total: MOCK_TOKENS_PER_AGENT,
        cost: 0,
      });
      if (runOptions.schema !== undefined) return fabricateFromSchema(runOptions.schema);
      return `[dry-run] mock output for ${runOptions.label ?? "agent"}`;
    },
  } as unknown as AgentRunner;

  const agentCalls: ValidatedAgentCall[] = [];
  const checkpoints: ValidatedCheckpoint[] = [];

  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  const flows =
    options.workflows === undefined
      ? undefined
      : typeof options.workflows === "string" || Array.isArray(options.workflows)
        ? openWorkflowDir(options.workflows)
        : options.workflows;

  const manager = new WorkflowManager({
    agent: runner,
    cwd: baseCwd,
    journaling: false,
    persistenceRoot,
    loadSavedWorkflow: flows?.resolve,
  });
  manager.on("agentStart", (event: { label: string; phase?: string; model?: string }) => {
    const extra = mockMeta.get(event.label) ?? mockMeta.get("") ?? { schema: false };
    agentCalls.push({
      label: event.label,
      phase: event.phase,
      model: event.model,
      tier: extra.tier,
      mode: extra.mode,
      backend: attributeBackend(event.model, extra.tier, declaredBackends),
      schema: extra.schema,
    });
  });

  try {
    const run = await manager.runSync(script, options.args, {
      journaling: false,
      signal: controller.signal,
      tokenBudget: options.tokenBudget,
      maxAgents: options.maxAgents,
      scriptBackends: declaredBackends,
      confirm: async (promptText: string, checkpointOptions: unknown) => {
        const opts = (checkpointOptions ?? {}) as { kind?: string; default?: unknown; headless?: string };
        if (opts.headless === "abort") {
          warnings.push(
            `checkpoint "${truncate(promptText, 60)}" sets headless: "abort" — unattended runs will fail at it`,
          );
        }
        // Mirror the engine's headless resolution exactly: the declared default, else true.
        const reply = opts.default ?? true;
        checkpoints.push({ prompt: promptText, kind: opts.kind ?? "confirm", reply });
        return reply;
      },
    });

    // agentStart fires BEFORE the mock records its options, so backfill attribution for
    // any call whose mock metadata arrived after the event (same tick ordering).
    for (const call of agentCalls) {
      const extra = mockMeta.get(call.label);
      if (extra) {
        call.tier = extra.tier;
        call.mode = extra.mode;
        call.schema = extra.schema;
        call.backend = attributeBackend(call.model, extra.tier, declaredBackends);
      }
    }

    const ok = run.status === "completed";
    if (!ok && flows === undefined && run.reason?.includes("must be the first statement") && /\bworkflow\s*\(/.test(script)) {
      warnings.push(
        'the failure looks like a nested workflow("<name>") call on a bare name — provide workflow dirs ' +
          "(ValidateWorkflowOptions.workflows / --workflows-dir) so names resolve during the dry run",
      );
    }
    if (ok) {
      if (agentCalls.length === 0 && checkpoints.length === 0) {
        warnings.push("the script completed without a single agent() or checkpoint() call");
      }
      const declaredPhases = (meta.phases ?? []).map((p) => p.title);
      // A phase counts as used via phase() OR via a per-call agent({ phase }) assignment.
      const visited = new Set([...(run.phases ?? []), ...agentCalls.flatMap((c) => (c.phase ? [c.phase] : []))]);
      for (const title of declaredPhases) {
        if (!visited.has(title)) warnings.push(`meta.phases declares "${title}" but no phase("${title}") or agent({ phase }) used it`);
      }
      if (declaredPhases.length > 0) {
        for (const title of visited) {
          if (!declaredPhases.includes(title)) warnings.push(`phase "${title}" is used but meta.phases does not declare it`);
        }
      }
    }

    return {
      ok,
      exitCode: ok ? 0 : 2,
      parse: { ok: true, meta },
      dryRun: {
        ok,
        status: run.status,
        reason: timedOut ? `dry run exceeded ${timeoutMs}ms and was aborted` : run.reason,
        timedOut,
        agentCalls,
        checkpoints,
        phasesVisited: run.phases ?? [],
        logs: run.logs ?? [],
        durationMs: run.durationMs,
        result: run.result,
      },
      warnings,
    };
  } finally {
    clearTimeout(timer);
    try {
      rmSync(persistenceRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    if (ownedCwd) {
      try {
        rmSync(baseCwd, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Render a ValidateWorkflowReport as the human-readable CLI output. */
export function formatValidateReport(report: ValidateWorkflowReport): string {
  const lines: string[] = [];
  if (report.parse.ok) {
    const meta = report.parse.meta;
    const phases = meta?.phases?.length ? `${meta.phases.length} declared phase(s)` : "no declared phases";
    const backends = meta?.backends ? `, ${Object.keys(meta.backends).length} script-declared backend(s)` : "";
    lines.push(`✓ parse     "${meta?.name}" — ${phases}${backends}`);
  } else {
    lines.push(`✗ parse     ${report.parse.error}`);
  }

  const dry = report.dryRun;
  if (dry) {
    const summary = `${dry.agentCalls.length} agent call(s), ${dry.checkpoints.length} checkpoint(s), ${dry.durationMs}ms`;
    lines.push(dry.ok ? `✓ dry run   completed — ${summary}` : `✗ dry run   ${dry.status} — ${dry.reason ?? "unknown failure"} (${summary})`);
    for (const call of dry.agentCalls) {
      const spec = call.model ?? (call.tier ? `tier=${call.tier}` : "(default model)");
      const bits = [call.phase ? `[${call.phase}]` : undefined, spec, `→ ${call.backend}`, call.schema ? "(schema)" : undefined, call.mode ? `mode=${call.mode}` : undefined]
        .filter(Boolean)
        .join("  ");
      lines.push(`    • ${call.label}  ${bits}`);
    }
    for (const cp of dry.checkpoints) {
      lines.push(`    ◆ checkpoint [${cp.kind}] "${truncate(cp.prompt, 60)}" → ${JSON.stringify(cp.reply)}`);
    }
  } else if (report.parse.ok) {
    lines.push("- dry run   skipped (--parse-only)");
  }

  for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  lines.push(report.ok ? "result: valid" : "result: INVALID");
  return lines.join("\n");
}
