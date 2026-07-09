import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACP_CROSS_CUTTING_EVENT_NAMES, AUTH_META_MATRIX, CODEX_SPAWN_AUTH_ENV } from "../src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("cross-cutting ACP event names are documented in public event tables", () => {
  const docs = [
    "packages/workflows/README.md",
    "packages/acp-agents/README.md",
    "docs/api.md",
  ];

  for (const path of docs) {
    const text = readRepoFile(path);
    for (const name of ACP_CROSS_CUTTING_EVENT_NAMES) {
      assert.ok(text.includes(`\`${name}\``), `${path} must document ${name}`);
    }
  }
});

// §4.6.4 item 4 — the full `_meta` support matrix (§3.6) lives as executable data in
// protocol-coverage.ts, not prose alone. Assert the code matrix and the frozen spec §3.6 cannot
// drift apart: every matrix row's capability literal must appear in the spec's §3.6 section, and the
// spec must still document the codex DEFAULT_AUTH_REQUEST channel and the -32000 auth-exclusivity.
test("the executable AUTH_META_MATRIX stays in lockstep with spec §3.6", () => {
  const spec = readRepoFile("docs/specs/acp-auth-spec.md");
  const start = spec.indexOf("### 3.6 Full `_meta` capability support matrix");
  assert.ok(start >= 0, "spec must contain the §3.6 matrix section");
  const end = spec.indexOf("\n## ", start);
  const section = spec.slice(start, end === -1 ? undefined : end);

  for (const row of AUTH_META_MATRIX) {
    assert.ok(
      section.includes(row.capability),
      `spec §3.6 must document the "${row.capability}" (${row.agent}) _meta surface`,
    );
  }
  assert.ok(section.includes(CODEX_SPAWN_AUTH_ENV), "spec §3.6 must cite the DEFAULT_AUTH_REQUEST channel");
  // The -32000 auth-exclusivity guarantee the §1.5 matcher relies on is stated in the spec.
  assert.ok(spec.includes("-32000"), "spec must document the -32000 auth-required code");
});

test("adapter versions cited in docs match the installed acp-agents dependencies", () => {
  const packageJson = JSON.parse(readRepoFile("packages/acp-agents/package.json")) as {
    dependencies: Record<string, string>;
  };
  const expected = new Map([
    ["@agentclientprotocol/claude-agent-acp", packageJson.dependencies["@agentclientprotocol/claude-agent-acp"]],
    ["@automatalabs/codex-acp", packageJson.dependencies["@automatalabs/codex-acp"]],
  ]);

  for (const path of ["docs/api.md", "docs/design-notes.md"]) {
    const text = readRepoFile(path);
    for (const [packageName, version] of expected) {
      const cited = [
        ...text.matchAll(new RegExp(`${escapeRegExp(packageName)}@([^\\s\`),]+)`, "g")),
      ].map((match) => match[1]);
      assert.ok(cited.length > 0, `${path} must cite ${packageName}@${version}`);
      assert.deepEqual([...new Set(cited)], [version], `${path} ${packageName} version citations drifted`);
    }
  }
});
