import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_BACKENDS,
  BUILTIN_BACKEND_IDS,
  BUILTIN_PROTOCOL_COVERAGE,
  ClaudeBackend,
  CodexBackend,
  OpenCodeBackend,
  PiBackend,
  builtinBackend,
  builtinThoughtLevelDomainSemantics,
  claudeAuthProfile,
  codexAuthProfile,
  opencodeAuthProfile,
  piAuthProfile,
  type AuthProfile,
  type Backend,
  type BuiltinBackendDefinition,
  type BuiltinBackendId,
  type BuiltinBackendReleaseMetadata,
  type BuiltinProtocolCoverageRow,
  type TerminalLaunch,
  type ThoughtLevelDomainSemantics,
} from "../src/index.js";
import type { BuiltinBackendId as CompatibilityBuiltinBackendId } from "../src/backend.js";
import { claudeAuthProfile as ShimClaudeProfile } from "../src/auth/auth-profiles.js";
import { ClaudeBackend as PathClaudeBackend } from "../src/backends/claude.js";
import {
  assertBuiltinBackendTable,
} from "../src/backends/builtins.js";
import { defineBuiltinBackend } from "../src/backends/define.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type _RegistryKeysDefineId = Expect<Equal<BuiltinBackendId, keyof typeof BUILTIN_BACKENDS>>;
type _CompatibilityTypeMatches = Expect<
  Equal<CompatibilityBuiltinBackendId, BuiltinBackendId>
>;
type FifthRowFixture = keyof (typeof BUILTIN_BACKENDS & {
  fifth: (typeof BUILTIN_BACKENDS)["claude"];
});
const fifthRowWidensWithoutAUnion: FifthRowFixture = "fifth";
void fifthRowWidensWithoutAUnion;

// Compile-time root export locks.
const rootTypeLocks: [
  BuiltinBackendDefinition<string> | undefined,
  BuiltinBackendReleaseMetadata | undefined,
  BuiltinProtocolCoverageRow | undefined,
  AuthProfile | undefined,
  TerminalLaunch | undefined,
  ThoughtLevelDomainSemantics | undefined,
] = [undefined, undefined, undefined, undefined, undefined, undefined];
void rootTypeLocks;

test("registry order, ids, profiles, factories, and central coverage are exactly aligned", () => {
  assert.deepEqual(BUILTIN_BACKEND_IDS, ["claude", "codex", "opencode", "pi"]);
  assert.deepEqual(Object.keys(BUILTIN_BACKENDS), BUILTIN_BACKEND_IDS);
  assert.deepEqual(Object.keys(BUILTIN_PROTOCOL_COVERAGE), BUILTIN_BACKEND_IDS);

  const profiles = {
    claude: claudeAuthProfile,
    codex: codexAuthProfile,
    opencode: opencodeAuthProfile,
    pi: piAuthProfile,
  } as const;
  const classes = {
    claude: ClaudeBackend,
    codex: CodexBackend,
    opencode: OpenCodeBackend,
    pi: PiBackend,
  } as const;
  const defaultModes = {
    claude: "auto",
    codex: "agent",
    opencode: "build",
    pi: undefined,
  } as const;
  const thoughtLevelDomains = {
    claude: "ordered",
    codex: "ordered",
    opencode: "exact-set",
    pi: "ordered",
  } as const;

  for (const id of BUILTIN_BACKEND_IDS) {
    const definition = BUILTIN_BACKENDS[id];
    const backend = definition.create();
    assert.equal(definition.id, id);
    assert.equal(definition.defaultModeId, defaultModes[id]);
    assert.equal(backend.defaultModeId, defaultModes[id]);
    assert.equal(definition.thoughtLevelDomainSemantics, thoughtLevelDomains[id]);
    assert.equal(builtinThoughtLevelDomainSemantics(id), thoughtLevelDomains[id]);
    assert.equal(definition.authProfile.backendId, id);
    assert.equal(backend.id, id);
    assert.strictEqual(definition.authProfile, profiles[id]);
    assert.strictEqual(backend.authProfile, definition.authProfile);
    assert.strictEqual(
      definition.protocolCoverage,
      BUILTIN_PROTOCOL_COVERAGE[id],
    );
    assert.ok(backend instanceof classes[id]);
  }

  assert.strictEqual(new ClaudeBackend().authProfile, claudeAuthProfile);
  assert.strictEqual(new CodexBackend().authProfile, codexAuthProfile);
  assert.strictEqual(new OpenCodeBackend().authProfile, opencodeAuthProfile);
  assert.strictEqual(new PiBackend().authProfile, piAuthProfile);
  assert.strictEqual(ShimClaudeProfile, claudeAuthProfile);
  assert.strictEqual(PathClaudeBackend, ClaudeBackend);
  assert.equal(builtinThoughtLevelDomainSemantics("custom"), undefined);
});

test("public lookup is own-property, exact-case, non-normalizing, and non-fallback", () => {
  for (const id of BUILTIN_BACKEND_IDS) assert.equal(builtinBackend(id)?.id, id);
  for (const unknown of ["", "Claude", "CLAUDE", "missing", "toString", "constructor"] as const) {
    assert.equal(builtinBackend(unknown), undefined, unknown);
  }
});

test("definitions and every release descendant are frozen against strict-mode mutation", () => {
  for (const id of BUILTIN_BACKEND_IDS) {
    const definition = BUILTIN_BACKENDS[id];
    const before = JSON.stringify(definition.release);
    assert.ok(Object.isFrozen(definition));
    assertFrozenTree(definition.release);

    assert.throws(() => ((definition.release as any).engine = { node: ">=999" }), TypeError);
    assert.throws(() => ((definition.release.engine as any).node = ">=999"), TypeError);
    assert.throws(() => ((definition.release.server as any).kind = "system-command"), TypeError);
    assert.throws(() => (definition.release.freshness.npm as any[]).push("extra"), TypeError);
    assert.throws(() => (definition.release.freshness.sourceUpstreams as any[]).push({}), TypeError);
    assert.throws(
      () => (definition.release.freshness.wrappedRuntimes as any[]).push({}),
      TypeError,
    );
    const upstream = definition.release.freshness.sourceUpstreams[0];
    if (upstream) {
      assert.throws(() => ((upstream as any).package = "changed"), TypeError);
      assert.throws(() => ((upstream as any).upstreamRef = "other"), TypeError);
    }
    assert.equal(JSON.stringify(definition.release), before);
  }
});

test("definition helper rejects profile, factory id, and profile-object mismatches", () => {
  const profile: AuthProfile = {
    backendId: "fixture",
    clientAuthCapabilities: () => undefined,
    describe: (_method, base) => base,
  };
  const coverage = BUILTIN_PROTOCOL_COVERAGE.claude;
  const release = BUILTIN_BACKENDS.claude.release;
  const backend = (id: string, authProfile: AuthProfile): Backend & {
    readonly id: "fixture";
    readonly authProfile: AuthProfile;
  } => ({
    id: id as "fixture",
    authProfile,
    spawnConfig: () => ({ command: "fixture", args: [], env: {} }),
    sessionMeta: () => undefined,
    promptMeta: () => undefined,
  });

  assert.throws(
    () => defineBuiltinBackend({
      id: "other",
      thoughtLevelDomainSemantics: "exact-set",
      authProfile: profile,
      create: (attached) => backend("other", attached) as never,
      release,
      protocolCoverage: coverage,
    }),
    /definition id "other" does not match auth profile id "fixture"/,
  );

  const wrongId = defineBuiltinBackend({
    id: "fixture",
    thoughtLevelDomainSemantics: "exact-set",
    authProfile: profile,
    create: (attached) => backend("different", attached),
    release,
    protocolCoverage: coverage,
  });
  assert.throws(() => wrongId.create(), /returned backend id "different"/);

  const copiedProfile = { ...profile };
  const wrongProfile = defineBuiltinBackend({
    id: "fixture",
    thoughtLevelDomainSemantics: "exact-set",
    authProfile: profile,
    create: () => backend("fixture", copiedProfile),
    release,
    protocolCoverage: coverage,
  });
  assert.throws(() => wrongProfile.create(), /did not attach its exact auth profile object/);

  assert.throws(
    () => assertBuiltinBackendTable({ wrong: BUILTIN_BACKENDS.claude }),
    /table key "wrong" does not match definition id "claude"/,
  );
});

test("source drift locks registry imports and import hygiene, including type-only syntax", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const runner = readFileSync(resolve(root, "packages/acp-agents/src/runner.ts"), "utf8");
  const workflows = readFileSync(resolve(root, "packages/workflows/src/config.ts"), "utf8");
  const define = readFileSync(resolve(root, "packages/acp-agents/src/backends/define.ts"), "utf8");
  const coverage = readFileSync(resolve(root, "packages/acp-agents/src/protocol-coverage.ts"), "utf8");
  const backend = readFileSync(resolve(root, "packages/acp-agents/src/backend.ts"), "utf8");

  assert.match(runner, /from "\.\/backends\/builtins\.js"/);
  assert.match(runner, /BUILTIN_BACKEND_IDS/);
  assert.match(runner, /builtinBackend/);
  assert.match(
    runner,
    /listBackends\(\)[\s\S]*?new Set<string>\(BUILTIN_BACKEND_IDS\)/,
  );
  assert.match(
    runner,
    /const custom = registry\?\.get\(firstSegment\);[\s\S]*?const builtIn = builtinBackend\(firstSegment\);/,
  );
  assert.match(
    runner,
    /function defaultBackend[\s\S]*?registry\.get\(name\)[\s\S]*?builtinBackend\(name\)[\s\S]*?BUILTIN_BACKENDS\.claude\.create\(\)/,
  );
  assertNoConcreteBackendDependencies(runner, new Set(["builtins", "custom"]));
  assertNoIdentityEqualityBranches(runner);
  assert.doesNotMatch(runner, /\bfunction\s+builtinBackend\b/);
  assert.match(
    workflows,
    /from "@automatalabs\/acp-agents"[\s\S]*?\[\.\.\.BUILTIN_BACKEND_IDS, \.\.\.registry\.keys\(\)\]/,
  );
  assert.doesNotMatch(workflows, /BUILTIN_HARNESSES/);

  const forbiddenDefineDependency = /BUILTIN_BACKENDS|["'][^"']*builtins(?:\.js)?["']/;
  for (const syntax of [
    'import { BUILTIN_BACKENDS } from "./builtins.js"',
    'import type { BuiltinBackendId } from "./builtins.js"',
    'import { type BuiltinBackendId } from "./builtins.js"',
    'type RegistryId = import("./builtins.js").BuiltinBackendId',
  ]) {
    assert.match(syntax, forbiddenDefineDependency);
  }
  assert.doesNotMatch(define, forbiddenDefineDependency);

  const forbiddenCoverageDependency = /BuiltinBackendId|BUILTIN_BACKENDS/;
  for (const syntax of [
    'import { ClaudeBackend } from "./backends/claude.js"',
    'import type { ClaudeBackend } from "./backends/claude.js"',
    'import { type ClaudeBackend } from "./backends/claude.js"',
    'type ConcreteBackend = import("./backends/claude.js").ClaudeBackend',
    'import type { BuiltinBackendId } from "./backend.js"',
  ]) {
    if (syntax.includes("BuiltinBackendId")) {
      assert.match(syntax, forbiddenCoverageDependency);
    } else {
      assert.throws(() => assertNoConcreteBackendDependencies(syntax), /claude/);
    }
  }
  assert.doesNotMatch(coverage, forbiddenCoverageDependency);
  assertNoConcreteBackendDependencies(coverage);
  assert.doesNotMatch(backend, /BuiltinBackendId\s*=\s*["']/);
});

test("source drift rules catch a fifth backend without adding its identity to the test", () => {
  for (const dependency of [
    'import { FifthBackend } from "./backends/fifth.js"',
    'import type { FifthBackend } from "./backends/fifth.js"',
    'import { type FifthBackend } from "./backends/fifth.js"',
    'type FifthBackend = import("./backends/fifth.js").FifthBackend',
  ]) {
    assert.throws(
      () => assertNoConcreteBackendDependencies(dependency, new Set(["builtins", "custom"])),
      /fifth/,
    );
  }

  for (const branch of [
    'if (firstSegment === "fifth") return new FifthBackend()',
    'if ("fifth" != name) return builtinBackend(name)',
    'const fifthId = "fifth"; if (firstSegment === fifthId) return new FifthBackend()',
  ]) {
    assert.throws(() => assertNoIdentityEqualityBranches(branch), /backend identity equality branch/);
  }
});

function assertNoConcreteBackendDependencies(
  source: string,
  allowedModules: ReadonlySet<string> = new Set(),
): void {
  const moduleSpecifiers = [...source.matchAll(/\b(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)]
    .map((match) => match[1]);
  const forbidden = moduleSpecifiers
    .map((specifier) => /(?:^|\/)backends\/([^/]+?)(?:\.(?:js|ts))?$/.exec(specifier)?.[1])
    .filter((module): module is string => module !== undefined && !allowedModules.has(module));
  assert.deepEqual(forbidden, [], `concrete backend dependencies are forbidden: ${forbidden.join(", ")}`);
}

function assertNoIdentityEqualityBranches(source: string): void {
  const identityEqualityBranch =
    /(?:\b(?:firstSegment|name)\s*(?:={2,3}|!={1,2})|(?:={2,3}|!={1,2})\s*\b(?:firstSegment|name))/;
  assert.doesNotMatch(source, identityEqualityBranch, "backend identity equality branch is forbidden");
}

function assertFrozenTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertFrozenTree(child);
}
