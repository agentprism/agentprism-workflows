import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

async function startRegistry(fixtures) {
  const byName = new Map(fixtures.map((fixture) => [fixture.name, fixture]));
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

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name: fixture.name,
        version: fixture.version,
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
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    }),
  };
}

function runGenerator(outputDir, registryUrl) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [script, "--output-dir", outputDir], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AGENTPRISM_ACP_REGISTRY_NPM_API: registryUrl,
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
