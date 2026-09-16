// Ref routing for the cold statics (src/agent/routing.ts) — no fake agent — plus the source weld
// that keeps the helpers the SDK shares with the runner from drifting apart silently.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionRef } from "@automatalabs/shared-types";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { AcpAgent, ClaudeBackend, CodexBackend, CustomAcpBackend, resolveBackendRegistry } from "../../src/index.js";
import {
  freshBackendFor,
  resolveAgentRegistry,
  resolveModelSwitch,
  resolveRefRoute,
  resolveSameBackendModel,
  validateAgentCwd,
} from "../../src/agent/routing.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (file: string): string => readFileSync(resolve(here, "../../src", file), "utf8");

const ref = (overrides: Partial<AgentSessionRef> = {}): AgentSessionRef => ({
  sessionId: "s",
  backendId: "claude",
  cwd: "/tmp",
  reopen: { load: true, resume: true, list: false },
  ...overrides,
});

function rejects(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(isWorkflowError(error), `expected a WorkflowError, got ${String(error)}`);
    assert.equal(error.code, WorkflowErrorCode.INVALID_ARGUMENT);
    assert.match(error.message, pattern);
    return true;
  });
}

test("resolveRefRoute honors custom-shadows-builtin, poolKey mismatch, same-backend model specs, and never falls back", () => {
  const builtins = resolveBackendRegistry({});
  const custom = resolveBackendRegistry({
    claude: { command: "wrapped-claude" },
    fake: { command: "fake-agent" },
  });
  const customClaude = new CustomAcpBackend(custom.get("claude")!);
  const previousDefault = process.env.AGENTPRISM_DEFAULT_BACKEND;
  process.env.AGENTPRISM_DEFAULT_BACKEND = "codex";
  try {
    // Built-ins route by name; the poolKey of a built-in is its id.
    const plain = resolveRefRoute(ref(), undefined, builtins);
    assert.ok(plain.backend instanceof ClaudeBackend);
    assert.equal(plain.modelSpec, undefined);
    assert.ok(resolveRefRoute(ref({ backendId: "codex", poolKey: "codex" }), undefined, builtins).backend instanceof CodexBackend);

    // A registered custom entry of the same name wins over the built-in — and carries its own poolKey.
    const shadowed = resolveRefRoute(ref({ poolKey: customClaude.poolKey }), undefined, custom);
    assert.ok(shadowed.backend instanceof CustomAcpBackend);
    assert.equal(shadowed.backend.id, "claude");
    assert.notEqual(shadowed.backend, customClaude, "a fresh instance per route");
    rejects(() => resolveRefRoute(ref({ poolKey: "claude" }), undefined, custom), /pool key "claude" does not match/);
    rejects(() => resolveRefRoute(ref({ poolKey: "codex" }), undefined, builtins), /pool key "codex" does not match the currently resolved "claude"/);
    assert.ok(resolveRefRoute(ref(), undefined, custom).backend instanceof CustomAcpBackend, "no poolKey on the ref → no check");

    // Unknown names never fall back to the default backend (env says codex; still rejected).
    rejects(() => resolveRefRoute(ref({ backendId: "nope" }), undefined, builtins), /neither a built-in nor a registered custom/);
    rejects(() => resolveRefRoute(ref({ backendId: "nope" }), "codex", custom), /neither a built-in nor a registered custom/);

    // Model specs: same backend strips the prefix (case-insensitively), a backend-only spec is bare,
    // another KNOWN backend is rejected, and an unrouted spec goes verbatim to the ref's backend.
    assert.equal(resolveRefRoute(ref(), "claude/opus", builtins).modelSpec, "opus");
    assert.equal(resolveRefRoute(ref(), "CLAUDE/opus", builtins).modelSpec, "opus");
    assert.equal(resolveRefRoute(ref(), "claude/vendor/opus", builtins).modelSpec, "vendor/opus");
    assert.equal(resolveRefRoute(ref(), "claude", builtins).modelSpec, undefined);
    assert.equal(resolveRefRoute(ref(), "claude/", builtins).modelSpec, "");
    rejects(() => resolveRefRoute(ref(), "codex/x", builtins), /routes to "codex" but the session ref belongs to "claude"/);
    rejects(() => resolveRefRoute(ref(), "fake/x", custom), /routes to "fake"/);
    rejects(() => resolveRefRoute(ref({ backendId: "fake" }), "claude/x", custom), /routes to "claude"/);
    const unrouted = resolveRefRoute(ref(), "gpt-5", builtins);
    assert.ok(unrouted.backend instanceof ClaudeBackend, "the ref's backend, never the default");
    assert.equal(unrouted.modelSpec, "gpt-5");
    assert.equal(resolveRefRoute(ref(), "openrouter/deepseek", builtins).modelSpec, "openrouter/deepseek");
  } finally {
    if (previousDefault === undefined) delete process.env.AGENTPRISM_DEFAULT_BACKEND;
    else process.env.AGENTPRISM_DEFAULT_BACKEND = previousDefault;
  }

  // freshBackendFor: the registered name wins, else the built-in of that id; always a new object.
  const fresh = freshBackendFor(new ClaudeBackend(), builtins);
  assert.ok(fresh instanceof ClaudeBackend);
  const freshCustom = freshBackendFor(new ClaudeBackend(), custom);
  assert.ok(freshCustom instanceof CustomAcpBackend);
  assert.equal(freshCustom.id, "claude");

  // The registry read is a caller error when malformed.
  rejects(() => resolveAgentRegistry({ bad: {} as never }, "lbl"), /command/);
  rejects(() => validateAgentCwd("relative", undefined, "X"), /X requires cwd to be a non-empty absolute path/);
  rejects(() => validateAgentCwd("/definitely/missing/dir", undefined, "X"), /does not exist or is not a directory/);
});

test("resolveSameBackendModel / resolveModelSwitch: the fork rule, shared by a mid-session switch", () => {
  const builtins = resolveBackendRegistry({});
  const custom = resolveBackendRegistry({ claude: { command: "wrapped-claude" }, fake: { command: "fake-agent" } });
  const claude = new ClaudeBackend();
  const codex = new CodexBackend();
  const previousDefault = process.env.AGENTPRISM_DEFAULT_BACKEND;
  delete process.env.AGENTPRISM_DEFAULT_BACKEND; // the default backend is claude
  try {
    // Same backend: the prefix is stripped (case-insensitively); backend-only is `undefined`.
    assert.equal(resolveSameBackendModel("claude/opus", claude, builtins, undefined, "M").modelSpec, "opus");
    assert.equal(resolveSameBackendModel("CLAUDE/opus[1m]", claude, builtins, undefined, "M").modelSpec, "opus[1m]");
    assert.equal(resolveSameBackendModel("claude", claude, builtins, undefined, "M").modelSpec, undefined);
    // Unrouted: the default backend — passes exactly when that is this agent's backend.
    assert.equal(resolveSameBackendModel("opus", claude, builtins, undefined, "M").modelSpec, "opus");
    rejects(
      () => resolveSameBackendModel("opus", codex, builtins, undefined, "M"),
      /^M: model "opus" routes to backend "claude" but must stay on backend "codex"$/,
    );
    // Another known backend: refused, naming both.
    rejects(
      () => resolveSameBackendModel("codex/x", claude, builtins, "lbl", "AcpAgent.fork()"),
      /^AcpAgent\.fork\(\): model "codex\/x" routes to backend "codex" but must stay on backend "claude"$/,
    );
    rejects(() => resolveSameBackendModel("fake/x", claude, custom, undefined, "M"), /routes to backend "fake" but must stay on backend "claude"/);
    // Pool identity, not id: a registry entry shadowing "claude" is a different pool than the built-in.
    const customClaude = new CustomAcpBackend(custom.get("claude")!);
    assert.equal(resolveSameBackendModel("claude/opus", customClaude, custom, undefined, "M").modelSpec, "opus");
    rejects(
      () => resolveSameBackendModel("claude/opus", claude, custom, undefined, "M"),
      new RegExp(`^M: model "claude/opus" routes to backend "claude" \\(pool "${customClaude.poolKey}"\\) but must stay on backend "claude" \\(pool "claude"\\)$`),
    );

    // A switch always names a model id: the routed remainder to send plus the spec `model` takes.
    assert.deepEqual(resolveModelSwitch("claude/opus[1m]", claude, builtins, undefined, "M"), { modelSpec: "opus[1m]", model: "claude/opus[1m]" });
    assert.deepEqual(resolveModelSwitch("opus", claude, builtins, undefined, "M"), { modelSpec: "opus", model: "claude/opus" });
    assert.deepEqual(resolveModelSwitch("claude/vendor/opus", claude, builtins, undefined, "M"), { modelSpec: "vendor/opus", model: "claude/vendor/opus" });
    rejects(() => resolveModelSwitch("claude", claude, builtins, undefined, "M"), /^M: model "claude" names backend "claude" but no model id; use "claude\/<model id>"$/);
    rejects(() => resolveModelSwitch("claude/", claude, builtins, undefined, "M"), /no model id/);
    rejects(() => resolveModelSwitch("claude/  ", claude, builtins, undefined, "M"), /no model id/);
    rejects(() => resolveModelSwitch("", claude, builtins, undefined, "M"), /^M requires a non-empty model spec \("claude\/<model id>"\)$/);
    rejects(() => resolveModelSwitch("   ", claude, builtins, undefined, "M"), /requires a non-empty model spec/);
    rejects(() => resolveModelSwitch(42, claude, builtins, undefined, "M"), /requires a non-empty model spec/);
    rejects(() => resolveModelSwitch("codex/x", claude, builtins, undefined, "M"), /must stay on backend "claude"/);
  } finally {
    if (previousDefault === undefined) delete process.env.AGENTPRISM_DEFAULT_BACKEND;
    else process.env.AGENTPRISM_DEFAULT_BACKEND = previousDefault;
  }
});

test(
  "validateAgentCwd reports a cwd it cannot stat (EACCES) as INVALID_ARGUMENT, not a raw Node error",
  { skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs a non-root POSIX user" : false },
  () => {
    const parent = mkdtempSync(join(tmpdir(), "acp-agent-cwd-eacces-"));
    const inner = join(parent, "inner");
    mkdirSync(inner);
    chmodSync(parent, 0o000);
    try {
      rejects(() => validateAgentCwd(inner, "lbl", "X"), /^X cwd is not accessible: .*inner \(EACCES\)$/);
      assert.throws(
        () => new AcpAgent({ cwd: inner, label: "lbl" }),
        (error: unknown) => {
          assert.ok(isWorkflowError(error), `expected a WorkflowError, got ${String(error)}`);
          assert.equal(error.code, WorkflowErrorCode.INVALID_ARGUMENT);
          assert.equal(error.agentLabel, "lbl");
          assert.match(error.message, /AcpAgent cwd is not accessible/);
          return true;
        },
      );
    } finally {
      chmodSync(parent, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test("the helpers copied from runner.ts cannot drift silently", () => {
  const runner = src("runner.ts");
  const structured = src("agent/structured.ts");
  const agent = src("agent/acp-agent.ts");
  const probe = src("agent/probe.ts");

  // The injection rule and the server-name suffixing are duplicated on purpose (the runner's are
  // private); both sides must carry the same literals.
  const injectionRule = "capabilities?.agent.mcpCapabilities?.http === true";
  assert.ok(runner.includes(injectionRule), "runner.ts injection rule");
  assert.ok(structured.includes(injectionRule), "structured.ts injection rule");
  const suffixLiteral = "`${base}_${suffix}`";
  assert.ok(runner.includes(suffixLiteral), "runner.ts server-name suffix");
  assert.ok(structured.includes(suffixLiteral), "structured.ts server-name suffix");
  const modeRule = "availableModes.some((mode) => mode.id === effectiveMode)";
  assert.ok(runner.includes(modeRule), "runner.ts default-mode rule");
  assert.ok(agent.includes(modeRule), "acp-agent.ts default-mode rule");

  // The moved helpers are SHARED, not copied: neither side defines them locally. The SDK's own
  // routing (agent/routing.ts) is the one place that reaches for `resolveModelRoute`; the class
  // takes the fork / setModel / per-turn rule from there.
  const agentRouting = src("agent/routing.ts");
  assert.doesNotMatch(runner, /function assertNoModelConfigOption|function sessionRefFor|function resolveModelRoute/);
  assert.doesNotMatch(agent, /function assertNoModelConfigOption|function sessionRefFor|function resolveModelRoute/);
  assert.doesNotMatch(agentRouting, /function assertNoModelConfigOption|function sessionRefFor|function resolveModelRoute/);
  assert.match(agent, /import \{ assertNoModelConfigOption, type ModelRoute \} from "\.\.\/routing\.js";/);
  assert.match(agentRouting, /import \{ asciiLowercase, resolveModelRoute, type ModelRoute \} from "\.\.\/routing\.js";/);
  assert.match(agent, /resolveModelSwitch,\n\s+resolveRefRoute,\n\s+resolveSameBackendModel,/);
  assert.match(agent, /import \{ sessionRefFor \} from "\.\.\/session-ref\.js";/);
  assert.match(runner, /from "\.\/routing\.js";/);
  assert.match(runner, /from "\.\/session-ref\.js";/);
  assert.match(probe, /import \{ resolveModelRoute \} from "\.\.\/routing\.js";/);

  // The SDK never reaches for the handle-owned escalation, the accumulator subtraction, or the
  // peeking capture reader (§11 row 7).
  for (const file of ["acp-agent.ts", "turn.ts", "structured.ts", "fork.ts", "probe.ts"]) {
    const text = src(`agent/${file}`);
    assert.doesNotMatch(text, /handle\.cancel\(\)|toAgentUsage\(\)|tryCaptured/, `${file} keeps to the SDK seams`);
  }
});
