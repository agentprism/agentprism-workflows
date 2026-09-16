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
import { resolveRefRoute, resolveAgentRegistry, freshBackendFor, validateAgentCwd } from "../../src/agent/routing.js";

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
    assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
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

test(
  "validateAgentCwd reports a cwd it cannot stat (EACCES) as SCRIPT_VALIDATION_ERROR, not a raw Node error",
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
          assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
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

  // The moved helpers are SHARED, not copied: neither side defines them locally.
  assert.doesNotMatch(runner, /function assertNoModelConfigOption|function sessionRefFor|function resolveModelRoute/);
  assert.doesNotMatch(agent, /function assertNoModelConfigOption|function sessionRefFor|function resolveModelRoute/);
  assert.match(agent, /import \{ assertNoModelConfigOption, resolveModelRoute \} from "\.\.\/routing\.js";/);
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
