import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "scripts", "generate-acp-registry.mjs");
const packageFixtures = await loadPackageFixtures();

test("generator publishes the official ACP top-level shape with pinned npm versions and icons", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "agentprism-acp-registry-"));
  const registry = await startRegistry(packageFixtures);

  try {
    const result = await runGenerator(outputDir, registry.url);
    assert.equal(result.code, 0, result.stderr);

    const publishedDir = join(outputDir, "acp-registry", "v1", "latest");
    const document = JSON.parse(await readFile(join(publishedDir, "registry.json"), "utf8"));
    assert.deepEqual(Object.keys(document), ["version", "agents", "extensions"]);
    assert.equal(document.version, "1.0.0");
    assert.deepEqual(document.extensions, []);
    assert.deepEqual(
      document.agents.map((agent) => agent.id),
      ["agentprism-acp-server", "agentprism-codex-acp", "agentprism-pi-acp"],
    );

    const expectedPackages = new Map(
      packageFixtures.map((fixture) => [fixture.name, fixture.version]),
    );
    for (const agent of document.agents) {
      assert.match(agent.id, /^[a-z][a-z0-9-]*$/);
      assert.match(agent.version, /^\d+\.\d+\.\d+$/);
      assert.equal(agent.license, "Apache-2.0");
      assert.deepEqual(agent.authors, ["Automata Labs"]);
      assert.equal(new URL(agent.repository).protocol, "https:");
      assert.equal(new URL(agent.website).protocol, "https:");
      assert.equal(new URL(agent.icon).protocol, "https:");
      assert.deepEqual(Object.keys(agent.distribution), ["npx"]);

      const packageSpec = agent.distribution.npx.package;
      const separator = packageSpec.lastIndexOf("@");
      const packageName = packageSpec.slice(0, separator);
      const version = packageSpec.slice(separator + 1);
      assert.equal(version, agent.version);
      assert.equal(expectedPackages.get(packageName), version);

      const icon = await readFile(join(publishedDir, `${agent.id}.svg`), "utf8");
      assert.match(icon, /width="16"/);
      assert.match(icon, /height="16"/);
      assert.match(icon, /currentColor/);
    }

    const [routerIcon, defaultIcon] = await Promise.all([
      readFile(join(publishedDir, "agentprism-acp-server.svg"), "utf8"),
      readFile(join(publishedDir, "agentprism-codex-acp.svg"), "utf8"),
    ]);
    assert.notEqual(routerIcon, defaultIcon);
  } finally {
    await registry.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("generator refuses to publish when npm latest has not reached the checked-in version", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "agentprism-acp-registry-stale-"));
  const stale = packageFixtures.map((fixture, index) =>
    index === 0 ? { ...fixture, version: "0.0.0" } : fixture,
  );
  const registry = await startRegistry(stale);

  try {
    const result = await runGenerator(outputDir, registry.url);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /refusing to advertise an unpublished or stale version/);
    await assert.rejects(
      stat(join(outputDir, "acp-registry", "v1", "latest", "registry.json")),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await registry.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("generator waits for a lagging npm latest to catch up when --wait-for-publish is given", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "agentprism-acp-registry-wait-"));
  // npm serves the previous release for a while after publication: two packages
  // start behind and catch up after two and three polls respectively.
  const lagging = packageFixtures.map((fixture, index) => {
    if (index === 0) return { ...fixture, laggingVersion: "0.0.0", laggingRequests: 2 };
    if (index === 2) return { ...fixture, laggingVersion: "0.0.1", laggingRequests: 3 };
    return fixture;
  });
  const registry = await startRegistry(lagging);

  try {
    const result = await runGenerator(outputDir, registry.url, {
      args: ["--wait-for-publish", "30"],
      env: { AGENTPRISM_ACP_REGISTRY_POLL_MS: "100" },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(
        `acp-registry: ${escapeRegExp(lagging[0].name)}: npm latest is 0\\.0\\.0, waiting for ` +
          `${escapeRegExp(lagging[0].version)} to publish \\(next check in 1s, \\d+s left\\)`,
      ),
    );
    assert.equal(registry.requestCount(lagging[0].name), 3);
    assert.equal(registry.requestCount(lagging[1].name), 1);
    assert.equal(registry.requestCount(lagging[2].name), 4);

    const publishedDir = join(outputDir, "acp-registry", "v1", "latest");
    const document = JSON.parse(await readFile(join(publishedDir, "registry.json"), "utf8"));
    const expectedPackages = new Map(
      packageFixtures.map((fixture) => [fixture.name, fixture.version]),
    );
    assert.equal(document.agents.length, packageFixtures.length);
    for (const agent of document.agents) {
      const packageSpec = agent.distribution.npx.package;
      const separator = packageSpec.lastIndexOf("@");
      const packageName = packageSpec.slice(0, separator);
      assert.equal(agent.version, expectedPackages.get(packageName));
      assert.equal(packageSpec.slice(separator + 1), expectedPackages.get(packageName));
      await stat(join(publishedDir, `${agent.id}.svg`));
    }
  } finally {
    await registry.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("generator stops waiting at the --wait-for-publish deadline and still refuses", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "agentprism-acp-registry-deadline-"));
  const neverPublished = packageFixtures.map((fixture, index) =>
    index === 1 ? { ...fixture, version: "0.0.0" } : fixture,
  );
  const registry = await startRegistry(neverPublished);

  try {
    const startedAt = performance.now();
    const result = await runGenerator(outputDir, registry.url, {
      args: ["--wait-for-publish", "2"],
      env: { AGENTPRISM_ACP_REGISTRY_POLL_MS: "200" },
    });
    const elapsedMs = performance.now() - startedAt;

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      new RegExp(
        `${escapeRegExp(neverPublished[1].name)}: npm latest is 0\\.0\\.0, but the checked-in version is ` +
          `${escapeRegExp(packageFixtures[1].version)}; refusing to advertise an unpublished or stale version`,
      ),
    );
    assert.ok(elapsedMs >= 1_900, `refused after ${elapsedMs}ms; expected the full 2s deadline`);
    assert.ok(
      registry.requestCount(neverPublished[1].name) >= 5,
      `expected repeated polls, saw ${registry.requestCount(neverPublished[1].name)}`,
    );
    assert.match(result.stdout, /waiting for .* to publish/);
    await assertNothingWritten(outputDir);
  } finally {
    await registry.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("generator refuses immediately without polling when npm latest is ahead of the checkout", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "agentprism-acp-registry-ahead-"));
  const ahead = packageFixtures.map((fixture, index) =>
    index === 2 ? { ...fixture, version: bumpMajor(fixture.version) } : fixture,
  );
  const registry = await startRegistry(ahead);

  try {
    const startedAt = performance.now();
    const result = await runGenerator(outputDir, registry.url, {
      args: ["--wait-for-publish", "60"],
      env: { AGENTPRISM_ACP_REGISTRY_POLL_MS: "200" },
    });
    const elapsedMs = performance.now() - startedAt;

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      new RegExp(
        `${escapeRegExp(ahead[2].name)}: npm latest is ${escapeRegExp(ahead[2].version)}, but the ` +
          `checked-in version is ${escapeRegExp(packageFixtures[2].version)}; refusing to advertise ` +
          "an unpublished or stale version",
      ),
    );
    assert.ok(elapsedMs < 20_000, `refused after ${elapsedMs}ms; expected no wait`);
    assert.equal(registry.requestCount(ahead[2].name), 1);
    assert.doesNotMatch(result.stdout, /waiting for/);
    await assertNothingWritten(outputDir);
  } finally {
    await registry.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("generator rejects a zero or non-integer --wait-for-publish as a usage error", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "agentprism-acp-registry-usage-"));
  const registry = await startRegistry(packageFixtures);
  const usage =
    /usage: node scripts\/generate-acp-registry\.mjs --output-dir <directory> \[--wait-for-publish <seconds>\]/;

  try {
    for (const value of ["0", "-5", "1.5", "abc", "30s"]) {
      const result = await runGenerator(outputDir, registry.url, {
        args: ["--wait-for-publish", value],
      });
      assert.notEqual(result.code, 0, `--wait-for-publish ${value} was accepted`);
      assert.match(result.stderr, /--wait-for-publish must be a positive integer number of seconds/);
      assert.match(result.stderr, usage);
    }

    const missingValue = await runGenerator(outputDir, registry.url, { args: ["--wait-for-publish"] });
    assert.notEqual(missingValue.code, 0);
    assert.match(missingValue.stderr, usage);

    const repeated = await runGenerator(outputDir, registry.url, {
      args: ["--wait-for-publish", "5", "--wait-for-publish", "5"],
    });
    assert.notEqual(repeated.code, 0);
    assert.match(repeated.stderr, usage);

    for (const fixture of packageFixtures) assert.equal(registry.requestCount(fixture.name), 0);
    await assertNothingWritten(outputDir);
  } finally {
    await registry.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

async function loadPackageFixtures() {
  const fixtures = [];
  for (const directory of ["acp-server", "codex-acp", "pi-acp"]) {
    const manifest = JSON.parse(
      await readFile(join(repoRoot, "packages", directory, "package.json"), "utf8"),
    );
    fixtures.push({ name: manifest.name, version: manifest.version, bin: manifest.bin });
  }
  return fixtures;
}

// A fixture may carry `laggingVersion` and `laggingRequests`: the registry then
// serves `laggingVersion` for that package's first `laggingRequests` requests
// and `version` afterwards, mirroring npm's read path catching up with a publish.
async function startRegistry(fixtures) {
  const byName = new Map(fixtures.map((fixture) => [fixture.name, fixture]));
  const requestCounts = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const suffix = "/latest";
    const encodedName = url.pathname.endsWith(suffix)
      ? url.pathname.slice(1, -suffix.length)
      : "";
    const packageName = decodeURIComponent(encodedName);
    const fixture = byName.get(packageName);

    if (!fixture) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const requestCount = (requestCounts.get(packageName) ?? 0) + 1;
    requestCounts.set(packageName, requestCount);
    const version =
      fixture.laggingVersion !== undefined && requestCount <= fixture.laggingRequests
        ? fixture.laggingVersion
        : fixture.version;

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name: fixture.name,
        version,
        bin: fixture.bin,
      }),
    );
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requestCount: (packageName) => requestCounts.get(packageName) ?? 0,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    }),
  };
}

function runGenerator(outputDir, registryUrl, { args = [], env = {} } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [script, "--output-dir", outputDir, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AGENTPRISM_ACP_REGISTRY_NPM_API: registryUrl,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

async function assertNothingWritten(outputDir) {
  await assert.rejects(
    stat(join(outputDir, "acp-registry")),
    (error) => error?.code === "ENOENT",
  );
}

function bumpMajor(version) {
  const [major] = version.split(".");
  return `${Number(major) + 1}.0.0`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
