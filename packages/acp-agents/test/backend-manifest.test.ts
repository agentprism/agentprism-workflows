import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_BACKENDS,
  BUILTIN_BACKEND_IDS,
} from "../src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gateSource = resolve(repoRoot, "scripts/check-acp-deps.mjs");
const generatorSource = resolve(repoRoot, "scripts/generate-acp-backends-manifest.ts");
const committedManifest = resolve(repoRoot, "scripts/acp-backends.manifest.json");
const SDK = "@agentclientprotocol/sdk";
const EXAMPLE = "@agentclientprotocol/example-agent";
const secretMarker = "never-print-this-secret-value";

type JsonObject = Record<string, any>;

interface Registry {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

async function registry(routes: Record<string, { status?: number; body?: unknown }>): Promise<Registry> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url ?? "");
    requests.push(path);
    const route = routes[path];
    response.statusCode = route?.status ?? (route ? 200 : 404);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(route?.body ?? {}));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

function baseBackend(): JsonObject {
  return {
    id: "fixture",
    engine: { node: ">=22" },
    server: { kind: "system-command", command: "fixture" },
    freshness: { npm: [SDK], forks: [], wrappedRuntimes: [] },
  };
}

function baseManifest(): JsonObject {
  return { schemaVersion: 1, backends: [baseBackend()] };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function lockfile(dependencies: Record<string, string>, transitive: Record<string, string> = {}): string {
  const importer = Object.entries(dependencies)
    .map(([name, version]) => `      '${name}':\n        specifier: ^${version}\n        version: ${version}`)
    .join("\n");
  const packages = [...Object.entries(dependencies), ...Object.entries(transitive)]
    .map(([name, version]) => `  '${name}@${version}':\n    resolution: {integrity: sha512-fixture}`)
    .join("\n\n");
  return `lockfileVersion: '9.0'\n\nimporters:\n\n  packages/acp-agents:\n    dependencies:\n${importer}\n\npackages:\n\n${packages}\n`;
}

function fixtureRoot(options: {
  manifest?: JsonObject;
  rawManifest?: string;
  omitManifest?: boolean;
  packageManifest?: JsonObject;
  lock?: string;
  workspaces?: Record<string, JsonObject>;
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), "acp-manifest-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(gateSource, join(root, "scripts", "check-acp-deps.mjs"));
  if (!options.omitManifest) {
    writeFileSync(
      join(root, "scripts", "acp-backends.manifest.json"),
      options.rawManifest ?? JSON.stringify(options.manifest ?? baseManifest()),
    );
  }
  mkdirSync(join(root, "packages", "acp-agents"), { recursive: true });
  writeFileSync(
    join(root, "packages", "acp-agents", "package.json"),
    JSON.stringify(options.packageManifest ?? {
      name: "@automatalabs/acp-agents",
      engines: { node: ">=22" },
      dependencies: { [SDK]: "^1.2.1" },
    }),
  );
  for (const [path, manifest] of Object.entries(options.workspaces ?? {})) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "package.json"), JSON.stringify(manifest));
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  writeFileSync(
    join(root, "pnpm-lock.yaml"),
    options.lock ?? lockfile({ [SDK]: "1.2.1" }),
  );
  return root;
}

function runGate(
  root: string,
  registryUrl: string,
  environment: Record<string, string> = {},
): Promise<{ status: number | null; out: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(root, "scripts", "check-acp-deps.mjs")], {
      env: {
        ...process.env,
        AGENTPRISM_NPM_REGISTRY: registryUrl,
        AGENTPRISM_CODEX_ACP_DIR: secretMarker,
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", fail);
    child.on("close", (status) => done({ status, out }));
  });
}

function installManifestGitFixture(root: string): { bin: string; log: string } {
  const bin = join(root, "fixture-bin");
  const log = join(root, "fixture-git.log");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "git");
  writeFileSync(executable, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_GIT_LOG, JSON.stringify(args) + "\\n");
const command = args[2];
const rest = args.slice(3);
if (command === "remote" && rest[0] === "get-url") {
  process.stdout.write(rest[1] === "origin" ? process.env.FIXTURE_GIT_ORIGIN : process.env.FIXTURE_GIT_UPSTREAM);
} else if (command === "ls-remote") {
  process.stdout.write("ref: refs/heads/main\\tHEAD\\nfixture\\tHEAD\\n");
} else if (command === "rev-parse" && rest.includes("--abbrev-ref")) {
  process.stdout.write("main\\n");
} else if (command === "rev-list") {
  process.stdout.write("0\\n");
}
`);
  chmodSync(executable, 0o755);
  return { bin, log };
}

function generatorFixture(installedClaudeEngine?: string): string {
  const root = mkdtempSync(join(tmpdir(), "acp-generator-engine-"));
  const writePackage = (path: string, value: JsonObject) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value));
  };
  writePackage("packages/acp-agents/package.json", {
    name: "@automatalabs/acp-agents",
    engines: { node: ">=22" },
  });
  writePackage("packages/pi-acp/package.json", {
    name: "@automatalabs/pi-acp",
    engines: { node: ">=22.19.0" },
  });
  writePackage(
    "packages/acp-agents/node_modules/@agentclientprotocol/claude-agent-acp/package.json",
    {
      name: "@agentclientprotocol/claude-agent-acp",
      ...(installedClaudeEngine === undefined ? {} : { engines: { node: installedClaudeEngine } }),
    },
  );
  writePackage("packages/acp-agents/node_modules/@automatalabs/codex-acp/package.json", {
    name: "@automatalabs/codex-acp",
  });
  mkdirSync(join(root, "scripts"), { recursive: true });
  return root;
}

async function earlyFailure(
  server: Registry,
  options: Parameters<typeof fixtureRoot>[0],
  expected: RegExp,
): Promise<void> {
  const root = fixtureRoot(options);
  const before = server.requests.length;
  try {
    const result = await runGate(root, server.url);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, expected);
    assert.equal(server.requests.length, before, `network request escaped early validation:\n${result.out}`);
    assert.equal(result.out.includes(secretMarker), false, result.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("generated manifest is canonical and projects all registry rows in order", () => {
  const bytes = readFileSync(committedManifest, "utf8");
  assert.equal(bytes.endsWith("\n"), true);
  assert.equal(bytes.endsWith("\n\n"), false);
  const parsed = JSON.parse(bytes);
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.backends.map((row: { id: string }) => row.id), BUILTIN_BACKEND_IDS);
  assert.deepEqual(
    parsed.backends,
    BUILTIN_BACKEND_IDS.map((id) => ({
      id,
      engine: BUILTIN_BACKENDS[id].release.engine,
      server: BUILTIN_BACKENDS[id].release.server,
      freshness: BUILTIN_BACKENDS[id].release.freshness,
    })),
  );
  assert.equal(bytes, `${JSON.stringify(parsed, null, 2)}\n`);
});

test("generator --check leaves a corrupt manifest copy unchanged and names regeneration", () => {
  const root = mkdtempSync(join(tmpdir(), "acp-generator-check-"));
  const target = join(root, "manifest.json");
  const corrupt = '{"schemaVersion":1,"backends":[]}\n';
  writeFileSync(target, corrupt);
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", generatorSource, "--check", "--manifest", target],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.equal(result.status, 1, out);
    assert.equal(readFileSync(target, "utf8"), corrupt);
    assert.match(out, /pnpm generate:acp-backends-manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("after-install generator validates installed npm-server engines and permits an absent declaration", () => {
  for (const [installedEngine, expectedStatus] of [[undefined, 0], [">=23", 1]] as const) {
    const root = generatorFixture(installedEngine);
    const target = join(root, "scripts", "manifest.json");
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          generatorSource,
          "--repo-root",
          root,
          "--manifest",
          target,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      assert.equal(result.status, expectedStatus, out);
      if (installedEngine === undefined) {
        assert.deepEqual(
          JSON.parse(readFileSync(target, "utf8")).backends.map((row: JsonObject) => row.id),
          BUILTIN_BACKEND_IDS,
        );
      } else {
        assert.match(out, /claude engine\.node >=22 differs from installed .* engines\.node >=23/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("dependency-gate runbook section contains the manifest and all operator commands", () => {
  const contributing = readFileSync(join(repoRoot, "CONTRIBUTING.md"), "utf8");
  const heading = "### When the dependency gate blocks";
  const start = contributing.indexOf(heading);
  assert.notEqual(start, -1, `missing runbook heading: ${heading}`);
  const nextHeading = contributing.indexOf("\n### ", start + heading.length);
  const section = contributing.slice(start, nextHeading < 0 ? undefined : nextHeading);
  for (const token of [
    "scripts/acp-backends.manifest.json",
    "pnpm generate:acp-backends-manifest",
    "pnpm check:acp-backends-manifest",
    "node scripts/check-acp-deps.mjs",
  ]) {
    assert.ok(section.includes(token), `runbook section is missing exact token: ${token}`);
  }
});

test("schema version, engine grammar, malformed JSON, missing file, and unknown fields fail before network", async () => {
  const server = await registry({ [`/${SDK}/latest`]: { body: { version: "1.2.1" } } });
  try {
    for (const value of ["1", null, true, false, [], {}, 1.5, 2]) {
      const manifest = baseManifest();
      manifest.schemaVersion = value;
      await earlyFailure(server, { manifest }, /schemaVersion must be the number 1/);
    }
    for (const value of ["", "22", "banana", ">=022", ">=22 || >=24"]) {
      const manifest = baseManifest();
      manifest.backends[0].engine.node = value;
      await earlyFailure(server, { manifest }, /engine\.node/);
    }
    const unknown = baseManifest();
    unknown.backends[0].unexpected = true;
    await earlyFailure(server, { manifest: unknown }, /unexpected is an unrecognized field/);
    await earlyFailure(server, { rawManifest: "{not-json" }, /cannot read or parse/);
    await earlyFailure(server, { omitManifest: true }, /cannot read or parse/);
  } finally {
    await server.close();
  }
});

test("strict manifest schema rejects every missing, mistyped, unknown, and empty field before network", async () => {
  const server = await registry({});
  const validFork = {
    package: SDK,
    envDir: "FIXTURE_DIR",
    defaultDirs: ["$HOME/fixture"],
    tempCloneName: "fixture",
    originUrl: "https://example.test/fork.git",
    originUrlEnv: "FIXTURE_ORIGIN",
    upstreamUrl: "https://example.test/upstream.git",
    upstreamUrlEnv: "FIXTURE_UPSTREAM",
    upstreamRemote: "upstream",
  };
  const manifestWithRelations = () => {
    const manifest = baseManifest();
    manifest.backends[0].freshness.forks = [clone(validFork)];
    manifest.backends[0].freshness.wrappedRuntimes = [{
      adapterPackage: SDK,
      runtimePackage: "runtime-fixture",
    }];
    return manifest;
  };
  const cases: Array<[JsonObject, RegExp]> = [];
  const missing = (path: string[]) => {
    const manifest = baseManifest();
    let owner: JsonObject = manifest;
    for (const segment of path.slice(0, -1)) owner = owner[segment];
    delete owner[path.at(-1)!];
    return manifest;
  };
  for (const path of [
    ["schemaVersion"],
    ["backends"],
    ["backends", "0", "id"],
    ["backends", "0", "engine"],
    ["backends", "0", "server"],
    ["backends", "0", "freshness"],
    ["backends", "0", "engine", "node"],
    ["backends", "0", "server", "kind"],
    ["backends", "0", "server", "command"],
    ["backends", "0", "freshness", "npm"],
    ["backends", "0", "freshness", "forks"],
    ["backends", "0", "freshness", "wrappedRuntimes"],
  ]) cases.push([missing(path), /required/]);

  for (const field of ["package", "envDir", "defaultDirs", "tempCloneName", "originUrl", "originUrlEnv", "upstreamUrl", "upstreamUrlEnv", "upstreamRemote"]) {
    const manifest = manifestWithRelations();
    delete manifest.backends[0].freshness.forks[0][field];
    cases.push([manifest, /required/]);
  }
  for (const field of ["adapterPackage", "runtimePackage"]) {
    const manifest = manifestWithRelations();
    delete manifest.backends[0].freshness.wrappedRuntimes[0][field];
    cases.push([manifest, /required/]);
  }

  for (const [ownerPath, field] of [
    [[], "unexpected"],
    [["backends", "0"], "unexpected"],
    [["backends", "0", "engine"], "unexpected"],
    [["backends", "0", "server"], "unexpected"],
    [["backends", "0", "freshness"], "unexpected"],
  ] as Array<[string[], string]>) {
    const manifest = baseManifest();
    let owner: JsonObject = manifest;
    for (const segment of ownerPath) owner = owner[segment];
    owner[field] = true;
    cases.push([manifest, /unrecognized field/]);
  }
  for (const relation of ["forks", "wrappedRuntimes"] as const) {
    const manifest = manifestWithRelations();
    manifest.backends[0].freshness[relation][0].unexpected = true;
    cases.push([manifest, /unrecognized field/]);
  }

  for (const value of [null, {}, "not-an-array"]) {
    const manifest = baseManifest();
    manifest.backends = value;
    cases.push([manifest, /backends must be an array/]);
  }
  for (const field of ["npm", "forks", "wrappedRuntimes"]) {
    const manifest = baseManifest();
    manifest.backends[0].freshness[field] = null;
    cases.push([manifest, /must be an array/]);
  }
  for (const field of ["id"] as const) {
    const manifest = baseManifest();
    manifest.backends[0][field] = "";
    cases.push([manifest, /non-empty string/]);
  }
  {
    const manifest = baseManifest();
    manifest.backends[0].freshness.npm[0] = "";
    cases.push([manifest, /non-empty string/]);
  }
  for (const field of ["command", "optionalPackageProbe"]) {
    const manifest = baseManifest();
    manifest.backends[0].server[field] = "";
    cases.push([manifest, /non-empty string/]);
  }
  {
    const manifest = baseManifest();
    manifest.backends[0].server.kind = "unknown";
    cases.push([manifest, /server\.kind is unrecognized/]);
  }
  {
    const manifest = baseManifest();
    manifest.backends[0].server = { kind: "npm-package", package: "" };
    cases.push([manifest, /server\.package must be a non-empty string/]);
  }
  for (const field of ["package", "path"]) {
    const manifest = baseManifest();
    manifest.backends[0].server = {
      kind: "workspace-package",
      package: "@fixture/server",
      path: "packages/server",
      [field]: "",
    };
    cases.push([manifest, new RegExp(`server\\.${field} must be a non-empty string`)]);
  }
  for (const field of ["package", "envDir", "tempCloneName", "originUrl", "originUrlEnv", "upstreamUrl", "upstreamUrlEnv", "upstreamRemote"]) {
    const manifest = manifestWithRelations();
    manifest.backends[0].freshness.forks[0][field] = "";
    cases.push([manifest, /non-empty string/]);
  }
  {
    const manifest = manifestWithRelations();
    manifest.backends[0].freshness.forks[0].defaultDirs = [""];
    cases.push([manifest, /non-empty string/]);
  }
  for (const field of ["adapterPackage", "runtimePackage"]) {
    const manifest = manifestWithRelations();
    manifest.backends[0].freshness.wrappedRuntimes[0][field] = "";
    cases.push([manifest, /non-empty string/]);
  }

  try {
    for (const [manifest, expected] of cases) {
      await earlyFailure(server, { manifest }, expected);
    }
  } finally {
    await server.close();
  }
});

test("valid engine boundaries pass and source-of-truth divergence fails before network", async () => {
  const server = await registry({ [`/${SDK}/latest`]: { body: { version: "1.2.1" } } });
  try {
    for (const floor of [">=22", ">=22.19.0"]) {
      const manifest = baseManifest();
      manifest.backends[0].engine.node = floor;
      const root = fixtureRoot({
        manifest,
        packageManifest: {
          name: "@automatalabs/acp-agents",
          engines: { node: floor },
          dependencies: { [SDK]: "^1.2.1" },
        },
      });
      try {
        const result = await runGate(root, server.url);
        assert.equal(result.status, 0, result.out);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const mismatch = baseManifest();
    mismatch.backends[0].engine.node = ">=23";
    await earlyFailure(server, { manifest: mismatch }, /differs from packages\/acp-agents\/package\.json/);
  } finally {
    await server.close();
  }
});

test("empty work sets and every row-array duplicate class fail closed before network", async () => {
  const server = await registry({});
  try {
    await earlyFailure(server, { manifest: { schemaVersion: 1, backends: [] } }, /backends must not be empty/);
    const emptyNpm = baseManifest();
    emptyNpm.backends[0].freshness.npm = [];
    await earlyFailure(server, { manifest: emptyNpm }, /derived freshness\.npm set must not be empty/);

    const duplicateId = baseManifest();
    duplicateId.backends.push(clone(duplicateId.backends[0]));
    await earlyFailure(server, { manifest: duplicateId }, /backends ids must be duplicate-free/);
    const duplicateNpm = baseManifest();
    duplicateNpm.backends[0].freshness.npm.push(SDK);
    await earlyFailure(server, { manifest: duplicateNpm }, /freshness\.npm must be duplicate-free/);

    const duplicateFork = baseManifest();
    const fork = {
      package: SDK,
      envDir: "FIXTURE_DIR",
      defaultDirs: ["$HOME/fixture"],
      tempCloneName: "fixture",
      originUrl: "https://example.test/fork.git",
      originUrlEnv: "FIXTURE_ORIGIN",
      upstreamUrl: "https://example.test/upstream.git",
      upstreamUrlEnv: "FIXTURE_UPSTREAM",
      upstreamRemote: "upstream",
    };
    duplicateFork.backends[0].freshness.forks = [fork, clone(fork)];
    await earlyFailure(server, { manifest: duplicateFork }, /freshness\.forks must be duplicate-free/);

    const duplicateDirs = baseManifest();
    duplicateDirs.backends[0].freshness.forks = [{ ...fork, defaultDirs: ["$HOME/fixture", "$HOME/fixture"] }];
    await earlyFailure(server, { manifest: duplicateDirs }, /defaultDirs must be duplicate-free/);

    const duplicateWrapped = baseManifest();
    const wrapped = { adapterPackage: SDK, runtimePackage: "runtime-fixture" };
    duplicateWrapped.backends[0].freshness.wrappedRuntimes = [wrapped, clone(wrapped)];
    await earlyFailure(server, { manifest: duplicateWrapped }, /wrappedRuntimes must be duplicate-free/);
  } finally {
    await server.close();
  }
});

test("portable home tokens and server/fork/wrapper cross-fields fail deterministically", async () => {
  const server = await registry({});
  try {
    const fork = {
      package: SDK,
      envDir: "FIXTURE_DIR",
      defaultDirs: ["$HOME/fixture"],
      tempCloneName: "fixture",
      originUrl: "https://example.test/fork.git",
      originUrlEnv: "FIXTURE_ORIGIN",
      upstreamUrl: "https://example.test/upstream.git",
      upstreamUrlEnv: "FIXTURE_UPSTREAM",
      upstreamRemote: "upstream",
    };
    for (const token of ["/absolute/path", "$HOME/../escape", "$HOME/name*", "$OTHER/name"]) {
      const manifest = baseManifest();
      manifest.backends[0].freshness.forks = [{ ...fork, defaultDirs: [token] }];
      await earlyFailure(server, { manifest }, /invalid \$HOME/);
    }

    const npmRelation = baseManifest();
    npmRelation.backends[0].server = { kind: "npm-package", package: "npm-server" };
    await earlyFailure(server, { manifest: npmRelation }, /server\.package must appear/);

    const forkRelation = baseManifest();
    forkRelation.backends[0].freshness.forks = [{ ...fork, package: "fork-package" }];
    await earlyFailure(server, { manifest: forkRelation }, /forks\[0\]\.package must appear/);

    const wrapperRelation = baseManifest();
    wrapperRelation.backends[0].freshness.wrappedRuntimes = [{
      adapterPackage: "adapter-package",
      runtimePackage: "runtime-package",
    }];
    await earlyFailure(server, { manifest: wrapperRelation }, /adapterPackage must appear/);
  } finally {
    await server.close();
  }
});

test("direct/importer/transitive requirements and optional package probes have distinct semantics", async () => {
  const server = await registry({
    [`/${SDK}/latest`]: { body: { version: "1.2.1" } },
  });
  try {
    const missingDirect = baseManifest();
    missingDirect.backends[0].freshness.npm = ["@automatalabs/missing"];
    await earlyFailure(server, {
      manifest: missingDirect,
      packageManifest: {
        name: "@automatalabs/acp-agents",
        engines: { node: ">=22" },
      },
      lock: lockfile({}),
    }, /not a direct workspace dependency/);

    await earlyFailure(server, { lock: lockfile({}) }, /no pnpm-lock\.yaml importer resolution/);

    const wrapped = baseManifest();
    wrapped.backends[0].freshness.wrappedRuntimes = [{
      adapterPackage: SDK,
      runtimePackage: "transitive-runtime",
    }];
    await earlyFailure(server, { manifest: wrapped }, /no transitive pnpm-lock\.yaml resolution/);

    const optional = baseManifest();
    optional.backends[0].server.optionalPackageProbe = "package-that-is-not-installed";
    const root = fixtureRoot({ manifest: optional });
    try {
      const result = await runGate(root, server.url);
      assert.equal(result.status, 0, result.out);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    await server.close();
  }
});

test("workspace server path, package identity, and engine provenance are checked before network", async () => {
  const server = await registry({});
  const workspaceManifest = () => {
    const manifest = baseManifest();
    manifest.backends[0].server = {
      kind: "workspace-package",
      package: "@fixture/server",
      path: "packages/server",
    };
    return manifest;
  };
  try {
    await earlyFailure(server, { manifest: workspaceManifest() }, /does not resolve to a workspace package\.json/);
    await earlyFailure(server, {
      manifest: workspaceManifest(),
      workspaces: {
        "packages/server": { name: "@fixture/wrong", engines: { node: ">=22" } },
      },
    }, /server\.package .* differs/);
    await earlyFailure(server, {
      manifest: workspaceManifest(),
      workspaces: {
        "packages/server": { name: "@fixture/server", engines: { node: ">=23" } },
      },
    }, /engine\.node .* differs/);
    const escaping = workspaceManifest();
    escaping.backends[0].server.path = "../outside";
    await earlyFailure(server, { manifest: escaping }, /repository-relative path/);
  } finally {
    await server.close();
  }
});

test("reverse coverage scans dependencies, devDependencies, and optionalDependencies before network", async () => {
  const server = await registry({
    [`/${SDK}/latest`]: { body: { version: "1.2.1" } },
    [`/${EXAMPLE}/latest`]: { body: { version: "1.0.0" } },
  });
  try {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      await earlyFailure(server, {
        packageManifest: {
          name: "@automatalabs/acp-agents",
          engines: { node: ">=22" },
          dependencies: { [SDK]: "^1.2.1" },
          [field]: { ...(field === "dependencies" ? { [SDK]: "^1.2.1" } : {}), [EXAMPLE]: "^1.0.0" },
        },
      }, new RegExp(`freshness\\.npm omits ${EXAMPLE.replace("/", "\\/")}`));
    }

    const represented = baseManifest();
    represented.backends[0].freshness.npm.push(EXAMPLE);
    const root = fixtureRoot({
      manifest: represented,
      packageManifest: {
        name: "@automatalabs/acp-agents",
        engines: { node: ">=22" },
        dependencies: { [SDK]: "^1.2.1", [EXAMPLE]: "^1.0.0" },
      },
      lock: lockfile({ [SDK]: "1.2.1", [EXAMPLE]: "1.0.0" }),
    });
    try {
      const result = await runGate(root, server.url);
      assert.equal(result.status, 0, result.out);
      assert.ok(server.requests.includes(`/${EXAMPLE}/latest`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    await server.close();
  }
});

test("manifest-declared npm and wrapped-runtime work activate without gate source edits", async () => {
  const RUNTIME = "runtime-fixture";
  const server = await registry({
    [`/${SDK}/latest`]: { body: { version: "1.2.1", dependencies: { [RUNTIME]: "1.0.0" } } },
    [`/${SDK}/1.2.1`]: { body: { version: "1.2.1", dependencies: { [RUNTIME]: "1.0.0" } } },
    [`/${RUNTIME}/latest`]: { body: { version: "1.0.0" } },
  });
  const manifest = baseManifest();
  manifest.backends[0].freshness.wrappedRuntimes = [{
    adapterPackage: SDK,
    runtimePackage: RUNTIME,
  }];
  const root = fixtureRoot({
    manifest,
    lock: lockfile({ [SDK]: "1.2.1" }, { [RUNTIME]: "1.0.0" }),
  });
  try {
    const result = await runGate(root, server.url);
    assert.equal(result.status, 0, result.out);
    assert.ok(server.requests.includes(`/${SDK}/latest`));
    assert.ok(server.requests.includes(`/${RUNTIME}/latest`));
    assert.match(result.out, /runtime-fixture 1\.0\.0 \(wrapped by @agentclientprotocol\/sdk\) == latest/);
    assert.equal(readFileSync(join(root, "scripts", "check-acp-deps.mjs"), "utf8"), readFileSync(gateSource, "utf8"));
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a supplied fifth-backend fork relationship activates without gate source edits", async () => {
  const FIFTH = "@agentclientprotocol/fifth-backend";
  const originUrl = "https://git.invalid/runtime-owner/fifth-backend.git";
  const upstreamUrl = "https://git.invalid/runtime-upstream/fifth-backend.git";
  const fifth = baseBackend();
  fifth.id = "fifth";
  fifth.server.command = "fifth";
  fifth.freshness.npm = [FIFTH];
  fifth.freshness.forks = [{
    package: FIFTH,
    envDir: "AGENTPRISM_FIFTH_BACKEND_DIR",
    defaultDirs: ["$HOME/fifth-backend"],
    tempCloneName: "fifth-backend",
    originUrl: "https://git.invalid/declared-owner/fifth-backend.git",
    originUrlEnv: "AGENTPRISM_FIFTH_BACKEND_ORIGIN_URL",
    upstreamUrl: "https://git.invalid/declared-upstream/fifth-backend.git",
    upstreamUrlEnv: "AGENTPRISM_FIFTH_BACKEND_UPSTREAM_URL",
    upstreamRemote: "source",
  }];
  const manifest = baseManifest();
  manifest.backends.push(fifth);
  const root = fixtureRoot({
    manifest,
    packageManifest: {
      name: "@automatalabs/acp-agents",
      engines: { node: ">=22" },
      dependencies: { [SDK]: "^1.2.1", [FIFTH]: "^5.0.0" },
    },
    lock: lockfile({ [SDK]: "1.2.1", [FIFTH]: "5.0.0" }),
  });
  const workingClone = join(root, "fifth-working-clone");
  mkdirSync(join(workingClone, ".git"), { recursive: true });
  const gitFixture = installManifestGitFixture(root);
  const server = await registry({
    [`/${SDK}/latest`]: { body: { version: "1.2.1" } },
    [`/${FIFTH}/latest`]: { body: { version: "5.0.0" } },
  });
  try {
    const result = await runGate(root, server.url, {
      PATH: `${gitFixture.bin}${delimiter}${process.env.PATH ?? ""}`,
      FIXTURE_GIT_LOG: gitFixture.log,
      FIXTURE_GIT_ORIGIN: originUrl,
      FIXTURE_GIT_UPSTREAM: upstreamUrl,
      AGENTPRISM_FIFTH_BACKEND_DIR: workingClone,
      AGENTPRISM_FIFTH_BACKEND_ORIGIN_URL: originUrl,
      AGENTPRISM_FIFTH_BACKEND_UPSTREAM_URL: upstreamUrl,
    });
    assert.equal(result.status, 0, result.out);
    assert.ok(server.requests.includes(`/${FIFTH}/latest`));
    assert.match(result.out, new RegExp(`fork ${workingClone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.out, /runtime-upstream\/fifth-backend#main/);

    const calls = readFileSync(gitFixture.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(calls.some((args) => args.includes("source") && args.includes("fetch")));
    assert.ok(calls.some((args) => args.includes("source") && args.includes("ls-remote")));
    assert.ok(calls.some((args) => args.includes("pull") && args.includes("--ff-only")));
    assert.equal(calls.some((args) => args.includes("clone")), false);
    assert.equal(
      readFileSync(join(root, "scripts", "check-acp-deps.mjs"), "utf8"),
      readFileSync(gateSource, "utf8"),
    );
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm retries pin three attempts, a 10-second timeout, and 1.5/3-second backoff", { timeout: 15_000 }, async () => {
  const source = readFileSync(gateSource, "utf8");
  const constant = (name: string): number => {
    const match = new RegExp(`const ${name} = ([0-9_]+);`).exec(source);
    assert.ok(match, `${name} must remain an explicit zero-dependency numeric constant`);
    return Number(match[1].replaceAll("_", ""));
  };
  const attemptsContract = constant("FETCH_ATTEMPTS");
  const timeoutContract = constant("FETCH_TIMEOUT_MS");
  const retryDelayContract = constant("RETRY_DELAY_MS");
  assert.equal(attemptsContract, 3);
  assert.equal(timeoutContract, 10_000);
  assert.equal(retryDelayContract, 1_500);
  assert.deepEqual([1, 2].map((attempt) => retryDelayContract * attempt), [1_500, 3_000]);
  assert.match(source, /signal:\s*AbortSignal\.timeout\(FETCH_TIMEOUT_MS\)/);
  assert.match(
    source,
    /attempt\s*<\s*FETCH_ATTEMPTS\)\s*await new Promise\(\(r\)\s*=>\s*setTimeout\(r,\s*RETRY_DELAY_MS\s*\*\s*attempt\)\)/,
  );

  const notFound = await registry({ [`/${SDK}/latest`]: { status: 404 } });
  const root404 = fixtureRoot();
  try {
    const result = await runGate(root404, notFound.url);
    assert.equal(result.status, 1, result.out);
    assert.equal(notFound.requests.length, 1);
  } finally {
    await notFound.close();
    rmSync(root404, { recursive: true, force: true });
  }

  let attempts = 0;
  const requests: string[] = [];
  const retryServer = createServer((request, response) => {
    requests.push(request.url ?? "");
    attempts += 1;
    response.statusCode = attempts < 3 ? 503 : 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ version: "1.2.1" }));
  });
  await new Promise<void>((done) => retryServer.listen(0, "127.0.0.1", done));
  const rootRetry = fixtureRoot();
  try {
    const url = `http://127.0.0.1:${(retryServer.address() as AddressInfo).port}`;
    const result = await runGate(rootRetry, url);
    assert.equal(result.status, 0, result.out);
    assert.equal(requests.length, 3);
  } finally {
    await new Promise<void>((done) => retryServer.close(() => done()));
    rmSync(rootRetry, { recursive: true, force: true });
  }
});
