import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const packageRoot = new URL("../", import.meta.url);

test("T24 manifest has exact runtime pins and split packed entries", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
  assert.deepEqual(manifest.dependencies, {
    "@agentclientprotocol/sdk": "1.2.1",
    "@earendil-works/pi-coding-agent": "0.80.8",
    "@modelcontextprotocol/sdk": "1.29.0",
    typebox: "1.3.2",
  });
  assert.equal(manifest.main, "./dist/lib.js");
  assert.equal(manifest.exports["."].import, "./dist/lib.js");
  assert.equal(manifest.bin["pi-acp"], "./dist/index.js");
  assert.deepEqual(manifest.files, ["dist"]);
  assert.equal(manifest.publishConfig.types, "./dist/lib.d.ts");
});

test("T25 freshness gate tracks the direct pi runtime", async () => {
  const gate = await readFile(new URL("scripts/check-acp-deps.mjs", root), "utf8");
  assert.match(gate, /name\) => name === "@earendil-works\/pi-coding-agent"/);
});

test("T26 root project references pi-acp and a publishing changeset exists", async () => {
  const config = JSON.parse(await readFile(new URL("tsconfig.json", root), "utf8"));
  assert.ok(config.references.some(({ path }: { path: string }) => path === "packages/pi-acp"));
  // A Version Packages merge CONSUMES changesets into the changelog, so on a release
  // branch the guard is satisfied by the recorded release instead of a pending changeset.
  const changesets = await readdir(new URL(".changeset/", root));
  const bodies = await Promise.all(changesets.filter((name) => name.endsWith(".md")).map((name) => readFile(new URL(`.changeset/${name}`, root), "utf8")));
  const pendingChangeset = bodies.some((body) => body.includes('"@automatalabs/pi-acp"'));
  const releasedChangelog = await readFile(new URL("CHANGELOG.md", packageRoot), "utf8").then(
    (log) => /^## \d+\.\d+\.\d+/m.test(log),
    () => false,
  );
  assert.ok(pendingChangeset || releasedChangelog);
});

test("T27 README covers invocation, API, registration, T2b disclosure, limits, and attribution", async () => {
  const readme = await readFile(new URL("README.md", packageRoot), "utf8");
  for (const required of [
    "npx @automatalabs/pi-acp",
    "pi-acp --version",
    "runAcp(options?)",
    "PiAcpAgent",
    "resolveDeps",
    "PiAcpDeps",
    '"namespace": "@automatalabs/pi-acp"',
    '"gatedKeys": ["outputSchema"]',
    "provider/model-id",
    "-32000",
    "pi-stored-credentials",
    "mcp__",
    "__acp_structured_output",
    "tsc -p tsconfig.type-tests.json",
    "small deviation from the test-script example",
    "Version 1 limitations",
    "Built on pi",
    "THIRD-PARTY notice",
    "MIT License",
  ]) assert.ok(readme.includes(required), required);
});
