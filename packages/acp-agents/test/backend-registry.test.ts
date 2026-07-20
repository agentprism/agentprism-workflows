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
] = [undefined, undefined, undefined, undefined, undefined];
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

  for (const id of BUILTIN_BACKEND_IDS) {
    const definition = BUILTIN_BACKENDS[id];
    const backend = definition.create();
    assert.equal(definition.id, id);
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
    assert.throws(() => (definition.release.freshness.forks as any[]).push({}), TypeError);
    assert.throws(
      () => (definition.release.freshness.wrappedRuntimes as any[]).push({}),
      TypeError,
    );
    const fork = definition.release.freshness.forks[0];
    if (fork) {
      assert.throws(() => ((fork as any).package = "changed"), TypeError);
      assert.throws(() => (fork.defaultDirs as any[]).push("$HOME/other"), TypeError);
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
      authProfile: profile,
      create: (attached) => backend("other", attached) as never,
      release,
      protocolCoverage: coverage,
    }),
    /definition id "other" does not match auth profile id "fixture"/,
  );

  const wrongId = defineBuiltinBackend({
    id: "fixture",
    authProfile: profile,
    create: (attached) => backend("different", attached),
    release,
    protocolCoverage: coverage,
  });
  assert.throws(() => wrongId.create(), /returned backend id "different"/);

  const copiedProfile = { ...profile };
  const wrongProfile = defineBuiltinBackend({
    id: "fixture",
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
  assert.doesNotMatch(runner, /from "\.\/backends\/(?:claude|codex|opencode|pi)\.js"/);
  assert.doesNotMatch(
    runner,
    /function builtinBackend|(?:firstSegment|name)\s*===\s*["'](?:claude|codex|opencode|pi)["']/,
  );
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

  const forbiddenCoverageDependency =
    /BuiltinBackendId|BUILTIN_BACKENDS|["'][^"']*backends\/(?:claude|codex|opencode|pi)(?:\.js)?["']/;
  for (const syntax of [
    'import { ClaudeBackend } from "./backends/claude.js"',
    'import type { ClaudeBackend } from "./backends/claude.js"',
    'import { type ClaudeBackend } from "./backends/claude.js"',
    'type ConcreteBackend = import("./backends/claude.js").ClaudeBackend',
    'import type { BuiltinBackendId } from "./backend.js"',
  ]) {
    assert.match(syntax, forbiddenCoverageDependency);
  }
  assert.doesNotMatch(coverage, forbiddenCoverageDependency);
  assert.doesNotMatch(backend, /BuiltinBackendId\s*=\s*["']/);
});

function assertFrozenTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertFrozenTree(child);
}
