import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import type { ClientSideConnection, InitializeResponse } from "@agentclientprotocol/sdk";
import {
  ACP_AUTH_REQUIRED_CODE_EXCLUSIVE,
  ACP_EXTENSION_SUPPORT_MATRIX,
  AGENT_METHOD_COVERAGE,
  AUTH_CAPABILITY_KEYS,
  AUTH_META_CONVENTION_KEYS,
  AUTH_META_MATRIX,
  BUILTIN_PROTOCOL_COVERAGE,
  CLIENT_METHOD_COVERAGE,
  CODEX_SPAWN_AUTH_ENV,
  FORK_SESSION_TRAITS,
  FORK_SESSION_TRAIT_DEFAULT,
  HANDLED_AUTH_METHOD_TYPES,
  PI_ACP_PROTOCOL_CONTRACT,
  COST_GAUGE_INHERITANCE,
  COST_GAUGE_INHERITANCE_DEFAULT,
  PROMPT_USAGE_SCOPES,
  SESSION_STEERING_METHOD,
  SYSTEM_PROMPT_SUPPORT,
  assertAuthCapabilityShape,
  clientCapabilitiesFor,
  forkSessionTrait,
  costGaugeInheritance,
  promptUsageScope,
  systemPromptSupport,
} from "../src/index.js";

type Expect<T extends true> = T;
type _InitializeMetaSchemaPinned = Expect<
  Exclude<InitializeResponse["_meta"], null | undefined> extends Record<string, unknown>
    ? true
    : false
>;

function compileGenericSdkOverloads(connection: ClientSideConnection): void {
  const request: Promise<{ exact: true }> = connection.request<
    { exact: true },
    { value: string }
  >("example.test/generic", { value: "verbatim" });
  const notification: Promise<void> = connection.notify<{ value: string }>(
    "example.test/notification",
    { value: "verbatim" },
  );
  void request;
  void notification;
}
void compileGenericSdkOverloads;

test("SDK initialize metadata schema and generic request/notify overloads remain present", () => {
  const meta: InitializeResponse["_meta"] = { nested: { supported: true } };
  assert.deepEqual(meta, { nested: { supported: true } });
});

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function assertSameSet(actual: Iterable<string>, expected: Iterable<string>, label: string): void {
  assert.deepEqual(sorted(actual), sorted(expected), `${label} coverage must match the installed SDK`);
}

test("client method coverage classifies every installed SDK client method", () => {
  // PROTOCOL_METHODS (`$/cancel_request`) is SDK-internal JSON-RPC plumbing, not ACP surface
  // this runner serves or drives.
  assertSameSet(Object.keys(CLIENT_METHOD_COVERAGE), Object.values(CLIENT_METHODS), "client method");
  assert.equal(
    Object.values(CLIENT_METHOD_COVERAGE).filter((coverage) => coverage === "served").length,
    14,
    "client served count should match docs",
  );
});

test("agent method coverage classifies every installed SDK agent method", () => {
  assertSameSet(Object.keys(AGENT_METHOD_COVERAGE), Object.values(AGENT_METHODS), "agent method");
  assert.equal(
    Object.entries(AGENT_METHOD_COVERAGE).filter(
      ([method, coverage]) => method !== AGENT_METHODS.initialize && coverage === "driven",
    ).length,
    16,
    "agent driven count excluding initialize should match docs",
  );
  assert.equal(
    Object.values(AGENT_METHOD_COVERAGE).filter((coverage) => coverage === "guarded").length,
    0,
    "agent guarded count should match docs",
  );
  assert.equal(
    Object.hasOwn(AGENT_METHOD_COVERAGE, SESSION_STEERING_METHOD),
    false,
    "the steering vendor extension must not be counted as a standard SDK agent method",
  );
});

// §4.6.4 item 1 — the client auth advertisement rides the SDK's UNSTABLE `AuthCapabilities` surface.
// Pin the emitted shape so a `@agentclientprotocol/sdk` bump that reshapes it trips the build.
test("clientCapabilitiesFor emits only the pinned SDK-1.2.1 AuthCapabilities keys", () => {
  const caps = clientCapabilitiesFor(undefined, { auth: { terminal: true, gateway: true } });
  assert.ok(caps.auth, "auth block advertised when a gate is requested");
  // Exactly `{ terminal, _meta }` — no extra/renamed keys.
  assert.deepEqual(Object.keys(caps.auth).sort(), [...AUTH_CAPABILITY_KEYS].sort());
  assert.doesNotThrow(() => assertAuthCapabilityShape(caps.auth));
  // The gateway-only and default-OFF shapes are also conformant (and null is vacuously fine).
  assert.doesNotThrow(() =>
    assertAuthCapabilityShape(clientCapabilitiesFor(undefined, { auth: { gateway: true } }).auth),
  );
  assert.doesNotThrow(() => assertAuthCapabilityShape(clientCapabilitiesFor(undefined).auth));
  assert.doesNotThrow(() => assertAuthCapabilityShape(undefined));
});

test("assertAuthCapabilityShape trips on a drifted (unpinned) auth key", () => {
  assert.throws(
    () => assertAuthCapabilityShape({ terminal: true, envVar: true } as never),
    /unpinned key "envVar"/,
  );
});

// §4.6.4 item 3 — the base dispatcher handles exactly the two SDK AuthMethod discriminants (ACP
// schema 1.21.0 removed `env_var`; the compile-time `_AuthMethodEnvVarAbsent` pin keeps it out).
test("HANDLED_AUTH_METHOD_TYPES is exactly agent/terminal", () => {
  assert.deepEqual([...HANDLED_AUTH_METHOD_TYPES], ["agent", "terminal"]);
});

// §4.6.4 items 4–5 — the cross-agent `_meta` convention surfaces the base layer keys on must still be
// present in the INSTALLED agent dists (claude/codex; opencode ships a compiled binary, §3.4), so an
// agent bump that moves a `_meta` surface fails the build BEFORE release, never silently.
const requireAcp = createRequire(new URL("../package.json", import.meta.url));
function readDist(spec: string): string {
  return readFileSync(requireAcp.resolve(spec), "utf8");
}
const CLAUDE_DIST = readDist("@agentclientprotocol/claude-agent-acp/dist/acp-agent.js");
const CODEX_DIST = readDist("@automatalabs/codex-acp");
const PI_DIST_DIR = dirname(requireAcp.resolve("@automatalabs/pi-acp"));
const PI_AGENT_DIST = readFileSync(join(PI_DIST_DIR, "agent.js"), "utf8");
const PI_AUTH_DIST = readFileSync(join(PI_DIST_DIR, "auth.js"), "utf8");
const PI_ERRORS_DIST = readFileSync(join(PI_DIST_DIR, "errors.js"), "utf8");

test("the cross-agent _meta convention keys are pinned and still present in the agent dists", () => {
  // The literal key names the base layer keys on (§1 intro) — not SDK schema fields.
  assert.deepEqual(AUTH_META_CONVENTION_KEYS, { gateway: "gateway", terminalAuth: "terminal-auth", apiKey: "api-key" });
  assert.equal(CODEX_SPAWN_AUTH_ENV, "DEFAULT_AUTH_REQUEST");

  // claude advertises the gateway `_meta` and the terminal-auth launch hint.
  assert.ok(CLAUDE_DIST.includes(AUTH_META_CONVENTION_KEYS.gateway), "claude dist still emits `gateway`");
  assert.ok(CLAUDE_DIST.includes(AUTH_META_CONVENTION_KEYS.terminalAuth), "claude dist still emits `terminal-auth`");

  // codex advertises api-key/gateway `_meta` and reads the DEFAULT_AUTH_REQUEST startup channel.
  assert.ok(CODEX_DIST.includes(AUTH_META_CONVENTION_KEYS.apiKey), "codex dist still emits `api-key`");
  assert.ok(CODEX_DIST.includes(AUTH_META_CONVENTION_KEYS.gateway), "codex dist still emits `gateway`");
  assert.ok(CODEX_DIST.includes(CODEX_SPAWN_AUTH_ENV), "codex dist still reads DEFAULT_AUTH_REQUEST");
});

test("every dist-probed AUTH_META_MATRIX row's capability literal is present in that agent's dist", () => {
  for (const row of AUTH_META_MATRIX) {
    assert.equal(row.status, "supported-today", `${row.agent}/${row.capability} must describe delivered behavior`);
    assert.ok(!Object.hasOwn(row, "owner"), `${row.agent}/${row.capability} must not publish deferred ownership`);
    const literal = row.distProbeLiteral ?? row.capability;
    if (row.distProbe === "claude") {
      assert.ok(CLAUDE_DIST.includes(literal), `claude dist must still carry "${literal}" (§3.6)`);
    } else if (row.distProbe === "codex") {
      assert.ok(CODEX_DIST.includes(literal), `codex dist must still carry "${literal}" (§3.6)`);
    }
  }
  // The matrix covers all four agent buckets and stays non-empty.
  assert.ok(AUTH_META_MATRIX.length >= 8);
  assert.ok(AUTH_META_MATRIX.some((r) => r.agent === "opencode"));
});

test("the executable ACP extension matrix documents installed advertisements without runtime gating", () => {
  assert.deepEqual(ACP_EXTENSION_SUPPORT_MATRIX, [
    {
      agent: "claude",
      method: "_session/steering",
      disposition: "supported",
      distProbe: "claude",
    },
    {
      agent: "codex",
      method: "_session/steering",
      disposition: "supported",
      distProbe: "codex",
    },
    {
      agent: "opencode",
      method: "_session/steering",
      disposition: "not-advertised",
    },
    {
      agent: "pi",
      method: "_session/steering",
      disposition: "supported",
    },
    {
      agent: "claude",
      method: "_session/loaded_turn/query",
      disposition: "not-advertised",
      distProbe: "claude",
    },
    {
      agent: "codex",
      method: "_session/loaded_turn/query",
      disposition: "supported",
      distProbe: "codex",
    },
    {
      agent: "opencode",
      method: "_session/loaded_turn/query",
      disposition: "not-advertised",
    },
    {
      agent: "pi",
      method: "_session/loaded_turn/query",
      disposition: "supported",
    },
  ]);

  for (const row of ACP_EXTENSION_SUPPORT_MATRIX) {
    const dist =
      row.distProbe === "claude"
        ? CLAUDE_DIST
        : row.distProbe === "codex"
          ? CODEX_DIST
          : undefined;
    if (!dist) continue;
    // A `supported` disposition means the installed distribution implements the method AND
    // advertises it at initialize. `not-advertised` records distribution evidence only; this
    // matrix is never consulted to gate a runtime extension request.
    if (row.disposition === "supported") {
      assert.ok(dist.includes(row.method), `${row.agent} dist must implement ${row.method}`);
      if (row.method === "_session/steering") {
        assert.match(
          dist,
          // Anchor on the steering block itself; other `_meta` extension keys may precede
          // it (the jetbrains/air block, upstream 0.67.0) or follow it (the goal extension,
          // upstream #371) as siblings, so require neither that `steering` opens `_meta`
          // nor that `supported: true` is `_meta`'s last entry — only that the steering
          // block itself advertises exactly `supported: true`.
          /steering\s*:\s*\{\s*supported\s*:\s*true\s*,?\s*\}/,
          `${row.agent} dist must advertise top-level steering support`,
        );
      } else {
        assert.match(
          dist,
          /_meta\s*:\s*\{[\s\S]*?loadedTurn\s*:\s*\{\s*supported\s*:\s*true/,
          `${row.agent} dist must advertise top-level loaded-turn support`,
        );
      }
    } else {
      assert.ok(!dist.includes(row.method), `${row.agent} dist must NOT implement ${row.method} until the matrix is updated`);
    }
  }
});

// The per-backend `session/fork` trait table. The `id-only` adapter answers the fork with a
// persisted copy that is not live (claude); `live` adapters hand back the session itself (codex —
// the workspace fork keeps the forked thread subscribed; pi — constructed on the serving process;
// opencode by live verification only). The rows are pinned exactly, then grounded in the installed
// adapter dists so an adapter bump that changes what a fork response IS fails the build.
const CLAUDE_FORK_DIST = readDist("@agentclientprotocol/claude-agent-acp/dist/fork-session.js"); // a DIFFERENT file from acp-agent.js
const BUILTIN_IDS = ["claude", "codex", "opencode", "pi"] as const;

test("FORK_SESSION_TRAITS pins the exact per-agent fork dispositions", () => {
  assert.deepEqual(
    FORK_SESSION_TRAITS.map(({ agent, disposition, reattach, cwd }) => ({ agent, disposition, reattach, cwd })),
    [
      { agent: "claude", disposition: "id-only", reattach: "resume-or-load", cwd: "source-only" },
      { agent: "codex", disposition: "live", reattach: "none", cwd: "free" },
      { agent: "opencode", disposition: "live", reattach: "none", cwd: "free" },
      { agent: "pi", disposition: "live", reattach: "none", cwd: "free" },
    ],
  );
  assert.ok(Object.isFrozen(FORK_SESSION_TRAITS));
  for (const row of FORK_SESSION_TRAITS) assert.ok(Object.isFrozen(row), `${row.agent} row is frozen`);
  // unknown agents: the ACP contract (a fork response is live; cwd free).
  assert.strictEqual(forkSessionTrait("browser"), FORK_SESSION_TRAIT_DEFAULT);
  assert.deepEqual(FORK_SESSION_TRAIT_DEFAULT, { agent: "*", disposition: "live", reattach: "none", cwd: "free" });
  // a declaration wins over the name (a custom entry called "claude" is not the built-in)
  assert.deepEqual(forkSessionTrait("claude", { disposition: "live" }), {
    agent: "claude",
    disposition: "live",
    reattach: "none",
    cwd: "free",
  });
  assert.deepEqual(forkSessionTrait("wrapped", { disposition: "id-only", cwd: "source-only" }), {
    agent: "wrapped",
    disposition: "id-only",
    reattach: "resume-or-load",
    cwd: "source-only",
  });
  assert.deepEqual(forkSessionTrait("wrapped", { disposition: "id-only" }), {
    agent: "wrapped",
    disposition: "id-only",
    reattach: "resume-or-load",
    cwd: "free",
  });
  assert.ok(Object.isFrozen(forkSessionTrait("wrapped", { disposition: "id-only" })));
  // the central coverage row carries the SAME frozen trait row (reference identity).
  for (const id of BUILTIN_IDS) assert.strictEqual(BUILTIN_PROTOCOL_COVERAGE[id].fork, forkSessionTrait(id));
});

test("fork traits are grounded in the installed agent dists", () => {
  for (const row of FORK_SESSION_TRAITS) {
    if (row.distProbe === undefined) {
      assert.equal(row.agent, "opencode", "only the compiled-binary agent has no fork dist probe");
    }
  }
  // claude: the fork returns only the persisted copy's id, read through the SDK keyed by the source cwd.
  assert.ok(CLAUDE_DIST.includes('import { forkSession } from "./fork-session.js";'));
  assert.ok(CLAUDE_FORK_DIST.includes("return { sessionId: forked.sessionId };"));
  assert.ok(CLAUDE_FORK_DIST.includes("forkClaudeSession(params.sessionId, {"));
  assert.ok(CLAUDE_FORK_DIST.includes("dir: params.cwd"));
  // codex: the fork is LIVE — thread/fork subscribes the connection like thread/resume, the adapter
  // keeps that subscription (no unsubscribe of the forked thread; the only threadUnsubscribe left
  // is session/close's), and no publish gate withholds the forked session's startup updates.
  assert.ok(CODEX_DIST.includes('method: "thread/fork"'), "the fork goes through thread/fork");
  assert.equal(CODEX_DIST.split("threadUnsubscribe({ threadId: response.thread.id })").length - 1, 0, "the forked thread is never unsubscribed");
  assert.ok(CODEX_DIST.includes("async threadUnsubscribe(params)"), "the wrapper still exists (guards the literal above)");
  assert.equal(CODEX_DIST.split("threadUnsubscribe({ threadId: sessionId })").length - 1, 1, "session/close is the one remaining unsubscribe call");
  assert.ok(!CODEX_DIST.includes("canPublishSessionUpdates"), "no fork publish gate");
  assert.ok(!CODEX_DIST.includes('operation !== "fork"'), "no fork publish gate");
  // pi: the fork is constructed live on the serving process and refuses a source with a turn in flight.
  assert.ok(PI_AGENT_DIST.includes("sessionCapabilities: { resume: {}, fork: {}, list: {}, close: {} }"));
  assert.ok(PI_AGENT_DIST.includes('adapterError("session_busy")'));
});

// The per-backend `PromptResponse.usage` scope. The SDK's own `Usage` doc says "across session";
// every installed adapter reports THE TURN, so a client-side session total is the client's own
// running sum. Pinned in the dists so an adapter that flips to cumulative reporting fails the
// build instead of silently doubling that sum.
const PI_SESSION_DIST = readFileSync(join(PI_DIST_DIR, "session.js"), "utf8");

test("prompt usage is per-turn on every source-verified agent", () => {
  assert.deepEqual(
    PROMPT_USAGE_SCOPES.map(({ agent, scope }) => ({ agent, scope })),
    [
      { agent: "claude", scope: "turn" },
      { agent: "codex", scope: "turn" },
      { agent: "opencode", scope: "turn" },
      { agent: "pi", scope: "turn" },
    ],
  );
  assert.ok(Object.isFrozen(PROMPT_USAGE_SCOPES));
  for (const id of BUILTIN_IDS) {
    assert.equal(promptUsageScope(id), "turn");
    assert.strictEqual(
      BUILTIN_PROTOCOL_COVERAGE[id].promptUsage,
      PROMPT_USAGE_SCOPES.find((row) => row.agent === id),
      `${id} coverage row carries the same frozen usage-scope row`,
    );
  }
  // custom agents: the ACP-client contract (per-turn).
  assert.equal(promptUsageScope("browser"), "turn");
  // claude: the accumulator the prompt response is read from is reset to the carried-over scratch at turn activation.
  assert.equal(CLAUDE_DIST.split("session.accumulatedUsage = session.activeTurn?.carriedUsage ?? {").length - 1, 1);
  assert.equal(CLAUDE_DIST.split("usage: sessionUsage(session),").length - 1, 1);
  // codex: the response carries the turn's last token count, nulled at turn start.
  assert.ok(CODEX_DIST.includes("usage: this.buildPromptUsage(sessionState.lastTokenUsage)"));
  assert.ok(CODEX_DIST.includes("sessionState.lastTokenUsage = null;"));
  // pi: only the assistant messages after the turn's start index are summed.
  assert.ok(PI_SESSION_DIST.includes("usage: promptUsage(messages)"));
  assert.ok(PI_SESSION_DIST.includes("agentMessages(this.pi).slice(turn.startMessageIndex)"));
  // the client side: recordPromptUsage replaces (never sums), so a session sum is the caller's own job.
  assert.match(
    readFileSync(new URL("../src/usage.ts", import.meta.url), "utf8"),
    /recordPromptUsage\(usage[^)]*\): void \{\s*if \(usage\) this\.promptUsage = usage;/,
  );
});

// §4.6.4 item 5 — the code-only matcher (§1.5) relies on `-32000` being auth-exclusive.
test("the pinned auth-required code is the SDK's exclusively-reserved -32000", () => {
  assert.equal(ACP_AUTH_REQUIRED_CODE_EXCLUSIVE, -32000);
});

test("the first-class Pi backend pins the frozen pi-acp capability/auth/error surface", () => {
  assert.deepEqual(PI_ACP_PROTOCOL_CONTRACT, {
    mcpCapabilities: { http: true, sse: true },
    authMethodIds: ["pi-stored-credentials"],
    providerErrorKinds: ["auth_error", "rate_limit", "billing_error", "provider_error"],
  });
  assert.ok(PI_AGENT_DIST.includes("http: true"));
  assert.ok(PI_AGENT_DIST.includes("sse: true"));
  assert.ok(!PI_AGENT_DIST.includes("outputSchema: true"));
  for (const methodId of PI_ACP_PROTOCOL_CONTRACT.authMethodIds) {
    assert.ok(PI_AUTH_DIST.includes(methodId), `installed pi-acp auth dist must contain ${methodId}`);
  }
  for (const errorKind of PI_ACP_PROTOCOL_CONTRACT.providerErrorKinds) {
    assert.ok(PI_ERRORS_DIST.includes(errorKind), `installed pi-acp errors dist must contain ${errorKind}`);
  }
});

// The per-backend system-prompt instruction channel (`SYSTEM_PROMPT_SUPPORT`): each row is read
// from its adapter's source, so pin the reader in the installed dists — an adapter bump that drops
// or renames its `_meta` key must fail here, never silently run the agent under its default prompt.
test("system-prompt support rows are grounded in the installed agent dists", () => {
  for (const row of SYSTEM_PROMPT_SUPPORT) {
    if (row.distProbe === undefined) {
      assert.equal(row.agent, "opencode", "only the compiled-binary agent has no system-prompt dist probe");
      assert.deepEqual({ replace: row.replace, append: row.append }, { replace: false, append: false });
      assert.deepEqual(row.metaKeys, []);
      continue;
    }
    assert.ok(row.replace && row.append, `${row.agent} carries both halves`);
  }
  // claude: `_meta.systemPrompt` — a string replaces the prompt, an object is merged into the
  // claude_code preset (so `{ append }` extends it) with type/preset locked.
  assert.ok(CLAUDE_DIST.includes("if (params._meta?.systemPrompt) {"));
  assert.ok(CLAUDE_DIST.includes('if (typeof customPrompt === "string") {'));
  assert.ok(CLAUDE_DIST.includes('preset: "claude_code",'));
  // codex: the bare base/developer keys are read on every thread-opening call — thread/start
  // (session/new), thread/resume (session/resume and session/load), and thread/fork (session/fork:
  // the fork is live, so its own request `_meta` is the only place a fork's instructions can ride).
  assert.match(CODEX_DIST, /readOptionalInstruction\(\w+, "baseInstructions"\)/);
  assert.match(CODEX_DIST, /readOptionalInstruction\(\w+, "developerInstructions"\)/);
  assert.equal(
    CODEX_DIST.split("...readInstructionOverrides(request._meta)").length - 1,
    4,
    "thread/start, thread/resume (resume + load), and thread/fork each spread the instruction overrides",
  );
  // pi: the reader runs on new/resume|load/fork and the loader overrides realize the instructions.
  assert.equal(PI_AGENT_DIST.split("readSystemPromptMeta(context.params._meta)").length - 1, 3);
  assert.ok(PI_AGENT_DIST.includes("...systemPromptLoaderOverrides(systemPrompt)"));
  assert.ok(PI_AGENT_DIST.includes("[SYSTEM_PROMPT_META_KEY]: { ...SYSTEM_PROMPT_ADVERTISEMENT }"));
  assert.deepEqual(systemPromptSupport("pi"), { replace: true, append: true });
  assert.deepEqual(systemPromptSupport("unknown-custom"), { replace: false, append: false });
  assert.ok(Object.isFrozen(SYSTEM_PROMPT_SUPPORT) && SYSTEM_PROMPT_SUPPORT.every((row) => Object.isFrozen(row)));
});

// The cumulative cost gauge (`usage_update.cost.amount`) across reopen and fork. Observed live, not
// readable from a dist: the fork/resume live e2e (`assertCostBaselined`) fails when an installed
// agent stops matching its row.
test("the cost gauge carries over on reopen everywhere, and on fork everywhere but claude", () => {
  assert.deepEqual(
    COST_GAUGE_INHERITANCE.map(({ agent, reopen, fork }) => ({ agent, reopen, fork })),
    [
      { agent: "claude", reopen: "inherits", fork: "restarts" },
      { agent: "codex", reopen: "inherits", fork: "inherits" },
      { agent: "opencode", reopen: "inherits", fork: "inherits" },
      { agent: "pi", reopen: "inherits", fork: "inherits" },
    ],
  );
  assert.ok(Object.isFrozen(COST_GAUGE_INHERITANCE));
  for (const id of BUILTIN_IDS) {
    assert.strictEqual(costGaugeInheritance(id), COST_GAUGE_INHERITANCE.find((row) => row.agent === id));
  }
  // Unknown and custom agents follow ACP (`cost` is the cumulative SESSION cost); a custom entry
  // named like a built-in is a different program and never takes the built-in's row.
  assert.strictEqual(costGaugeInheritance("somebody-elses-agent"), COST_GAUGE_INHERITANCE_DEFAULT);
  assert.strictEqual(costGaugeInheritance("claude", true), COST_GAUGE_INHERITANCE_DEFAULT);
  assert.deepEqual({ ...COST_GAUGE_INHERITANCE_DEFAULT }, { agent: "*", reopen: "inherits", fork: "inherits" });
});
