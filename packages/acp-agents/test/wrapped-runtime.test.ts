import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Regression for #196: scripts/check-acp-deps.mjs's wrapped-runtime check. An adapter
// (claude-agent-acp) can sit at npm latest while exact-pinning a stale agent runtime
// (claude-agent-sdk) inside it — the npm-freshness check is structurally blind to that axis.
// These tests run the real script against a hermetic repo root (fixture lockfile + packages)
// and a local stub registry (AGENTPRISM_NPM_REGISTRY), asserting: behind → fail with the right
// remediation; equal → pass; missing from lockfile → fail closed (unverifiable = blocked);
// override that upstream has caught up with → redundancy warning.

const REAL_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/check-acp-deps.mjs");
const ADAPTER = "@agentclientprotocol/claude-agent-acp";
const SDK = "@anthropic-ai/claude-agent-sdk";

async function startRegistry(routes: Record<string, unknown>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url ?? "");
    const body = routes[path];
    if (body === undefined) {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

function makeFixtureRoot(opts: {
  sdkLockedVersion?: string;
  rootOverrides?: Record<string, string>;
}): string {
  const tmp = mkdtempSync(join(tmpdir(), "acp-wrapped-"));
  mkdirSync(join(tmp, "scripts"), { recursive: true });
  copyFileSync(REAL_SCRIPT, join(tmp, "scripts", "check-acp-deps.mjs"));
  mkdirSync(join(tmp, "packages", "fixture"), { recursive: true });
  writeFileSync(
    join(tmp, "packages", "fixture", "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { [ADAPTER]: "0.59.0" } }),
  );
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({
      name: "fixture-root",
      private: true,
      ...(opts.rootOverrides ? { pnpm: { overrides: opts.rootOverrides } } : {}),
    }),
  );
  const sdkPackageEntry = opts.sdkLockedVersion
    ? `\n  '${SDK}@${opts.sdkLockedVersion}':\n    resolution: {integrity: sha512-fake}\n`
    : "";
  writeFileSync(
    join(tmp, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'\n\nimporters:\n\n  packages/fixture:\n    dependencies:\n      '${ADAPTER}':\n        specifier: 0.59.0\n        version: 0.59.0\n\npackages:\n\n  '${ADAPTER}@0.59.0':\n    resolution: {integrity: sha512-fake}\n${sdkPackageEntry}`,
  );
  return tmp;
}

// spawn (async), NOT spawnSync — the stub registry runs on THIS process's event loop, and a
// blocking wait would deadlock the child's fetches until they time out.
function runScript(root: string, registryUrl: string): Promise<{ out: string; status: number | null }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(root, "scripts", "check-acp-deps.mjs")], {
      env: { ...process.env, AGENTPRISM_NPM_REGISTRY: registryUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", fail);
    child.on("close", (status) => done({ out, status }));
  });
}

test("wrapped runtime behind latest fails with the override remediation (#196)", { timeout: 30_000 }, async () => {
  const root = makeFixtureRoot({ sdkLockedVersion: "0.3.207" });
  const registry = await startRegistry({
    [`/${ADAPTER}/latest`]: { version: "0.59.0", dependencies: { [SDK]: "0.3.207" } },
    [`/${SDK}/latest`]: { version: "0.3.211" },
  });
  try {
    const { out, status } = await runScript(root, registry.url);
    assert.equal(status, 1, `expected exit 1:\n${out}`);
    assert.ok(out.includes("wrapped agent runtime(s) BEHIND npm latest"), out);
    assert.ok(out.includes(`${SDK} (wrapped by ${ADAPTER}): installed 0.3.207, latest 0.3.211`), out);
    assert.ok(out.includes(`"pnpm": { "overrides": { "${SDK}": "0.3.211" } }`), out);
  } finally {
    await registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapped runtime behind latest points at the adapter bump when its latest wraps a current runtime", { timeout: 30_000 }, async () => {
  const root = makeFixtureRoot({ sdkLockedVersion: "0.3.207" });
  const registry = await startRegistry({
    [`/${ADAPTER}/latest`]: { version: "0.60.0", dependencies: { [SDK]: "0.3.211" } },
    [`/${SDK}/latest`]: { version: "0.3.211" },
  });
  try {
    const { out, status } = await runScript(root, registry.url);
    assert.equal(status, 1, `expected exit 1 (freshness + wrapped both fire):\n${out}`);
    assert.ok(out.includes(`bump ${ADAPTER}`), out);
    assert.ok(!out.includes('"pnpm": { "overrides"'), `expected the adapter-bump remediation, not the override:\n${out}`);
  } finally {
    await registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapped runtime at latest passes", { timeout: 30_000 }, async () => {
  const root = makeFixtureRoot({ sdkLockedVersion: "0.3.211" });
  const registry = await startRegistry({
    [`/${ADAPTER}/latest`]: { version: "0.59.0", dependencies: { [SDK]: "0.3.207" } },
    [`/${SDK}/latest`]: { version: "0.3.211" },
    [`/${ADAPTER}/0.59.0`]: { version: "0.59.0", dependencies: { [SDK]: "0.3.207" } },
  });
  try {
    const { out, status } = await runScript(root, registry.url);
    assert.equal(status, 0, `expected exit 0:\n${out}`);
    assert.ok(out.includes(`${SDK} 0.3.211 (wrapped by ${ADAPTER}) == latest — ok`), out);
    assert.ok(!out.includes("redundant"), `no override present — no redundancy warning expected:\n${out}`);
  } finally {
    await registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapped runtime missing from the lockfile fails closed", { timeout: 30_000 }, async () => {
  const root = makeFixtureRoot({});
  const registry = await startRegistry({
    [`/${ADAPTER}/latest`]: { version: "0.59.0", dependencies: { [SDK]: "0.3.207" } },
    [`/${SDK}/latest`]: { version: "0.3.211" },
  });
  try {
    const { out, status } = await runScript(root, registry.url);
    assert.equal(status, 1, `fail-closed expected (staleness that cannot be ruled out blocks):\n${out}`);
    assert.ok(out.includes(`${SDK} (wrapped by ${ADAPTER}) not found in pnpm-lock.yaml`), out);
    assert.ok(out.includes("the gate fails closed"), out);
  } finally {
    await registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("override that upstream has caught up with gets a redundancy warning", { timeout: 30_000 }, async () => {
  const root = makeFixtureRoot({
    sdkLockedVersion: "0.3.211",
    rootOverrides: { [SDK]: "0.3.211" },
  });
  const registry = await startRegistry({
    [`/${ADAPTER}/latest`]: { version: "0.59.0", dependencies: { [SDK]: "0.3.211" } },
    [`/${SDK}/latest`]: { version: "0.3.211" },
    [`/${ADAPTER}/0.59.0`]: { version: "0.59.0", dependencies: { [SDK]: "0.3.211" } },
  });
  try {
    const { out, status } = await runScript(root, registry.url);
    assert.equal(status, 0, `expected exit 0:\n${out}`);
    assert.ok(out.includes(`root pnpm override ${SDK}@0.3.211 is redundant`), out);
    assert.ok(out.includes("remove it from package.json pnpm.overrides"), out);
  } finally {
    await registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
