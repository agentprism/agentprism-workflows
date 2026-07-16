import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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

test("public package inventories cover every workspace package", () => {
  const packagesDir = join(repoRoot, "packages");
  const manifests = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      dir: entry.name,
      manifest: JSON.parse(readRepoFile(`packages/${entry.name}/package.json`)) as { name: string },
    }));

  assert.equal(manifests.length, 7, "update the documented package-count contract when the workspace changes");
  for (const path of ["README.md", "docs/api.md", "docs/design-notes.md"]) {
    const text = readRepoFile(path);
    for (const { manifest } of manifests) {
      assert.ok(text.includes(manifest.name), `${path} must inventory ${manifest.name}`);
    }
  }

  const contributing = readRepoFile("CONTRIBUTING.md");
  for (const { dir } of manifests) {
    assert.ok(contributing.includes(`packages/${dir}`), `CONTRIBUTING.md must inventory packages/${dir}`);
  }
  assert.match(contributing, /\(monorepo\) of seven packages/);
  assert.match(readRepoFile("docs/design-notes.md"), /monorepo of \*\*seven\*\* published packages/);
});

test("auth, MCP, and authoring docs retain the implemented contracts", () => {
  const packageJson = JSON.parse(readRepoFile("packages/acp-agents/package.json")) as {
    dependencies: Record<string, string>;
  };
  const codexVersion = packageJson.dependencies["@automatalabs/codex-acp"];
  const authSpec = readRepoFile("docs/specs/acp-auth-spec.md");
  assert.ok(authSpec.startsWith("# ACP Authentication — Implemented End-to-End Design Record"));
  assert.ok(authSpec.includes(`### 3.3 Codex — \`@automatalabs/codex-acp\` ${codexVersion}`));
  assert.ok(authSpec.includes("### 4.6 Implemented test matrix (historical plan)"));
  assert.ok(authSpec.includes("### 4.7 Completed PR sequencing (historical)"));

  const mcpReadme = readRepoFile("packages/mcp-server/README.md");
  for (const contract of ["OpenCode", "`AGENTPRISM_PERSISTENCE_ROOT`", "resumeFromRunId", "`author-workflow`"]) {
    assert.ok(mcpReadme.includes(contract), `MCP README must document ${contract}`);
  }
  // The MCP server's whole tool surface is the single `workflow` tool: backend auth belongs to
  // the agents' own CLI credential stores (auth/provider management lives in the SDK runner
  // APIs). Retired MCP tool names must not resurface in the current-state docs.
  const apiDocs = readRepoFile("docs/api.md");
  for (const retired of [
    "workflow_auth_status",
    "workflow_authenticate",
    "workflow_providers",
    "workflow_set_provider",
    "workflow_disable_provider",
    "AGENTPRISM_MCP_INLINE_AUTH",
  ]) {
    for (const [path, text] of [["packages/mcp-server/README.md", mcpReadme], ["docs/api.md", apiDocs]] as const) {
      assert.ok(!text.includes(retired), `${path} must not document the retired MCP surface ${retired}`);
    }
  }
  assert.ok(!mcpReadme.includes("return r.text"), "schema-less MCP examples return a string directly");

  const reference = readRepoFile("skills/agentprism-workflow-authoring/reference.md");
  assert.ok(reference.includes("| `keepSession` |"), "the exhaustive agent option table must include keepSession");
  assert.ok(reference.includes('reason: "auth_required"'), "authoring reference must explain auth pauses");
});

test("maintained examples do not reintroduce invalid agent/model contracts", () => {
  const maintainedDocs = [
    "README.md",
    "docs/api.md",
    "docs/design-notes.md",
    "packages/mcp-server/README.md",
    "packages/workflows/README.md",
    "skills/agentprism-workflow-authoring/SKILL.md",
    "skills/agentprism-workflow-authoring/reference.md",
  ];
  for (const path of maintainedDocs) {
    const text = readRepoFile(path);
    for (const retired of ["gpt-5.5-codex", "gpt-5.1-codex"]) {
      assert.ok(!text.includes(retired), `${path} contains the retired ${retired} example id`);
    }
    assert.doesNotMatch(
      text,
      /must (?:call|contain)[^\n]*agent\(\)[^\n]*at least once/i,
      `${path} must not claim agentless scripts are invalid`,
    );
  }
});
