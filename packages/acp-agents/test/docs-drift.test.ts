import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACP_CROSS_CUTTING_EVENT_NAMES,
  ACP_EXTENSION_SUPPORT_MATRIX,
  AUTH_META_MATRIX,
  CODEX_SPAWN_AUTH_ENV,
  PI_ACP_PROTOCOL_CONTRACT,
} from "../src/index.js";

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

test("steering documentation stays aligned with the executable extension matrix", () => {
  assert.deepEqual(
    ACP_EXTENSION_SUPPORT_MATRIX.map(({ agent, disposition }) => ({ agent, disposition })),
    [
      { agent: "claude", disposition: "supported" },
      { agent: "codex", disposition: "supported" },
      { agent: "opencode", disposition: "not-advertised" },
      { agent: "pi", disposition: "supported" },
      { agent: "claude", disposition: "not-advertised" },
      { agent: "codex", disposition: "supported" },
      { agent: "opencode", disposition: "not-advertised" },
      { agent: "pi", disposition: "supported" },
    ],
  );
  for (const path of ["packages/acp-agents/README.md", "packages/workflows/README.md", "docs/api.md"]) {
    const text = readRepoFile(path);
    assert.ok(text.includes("_session/steering"), `${path} must document the steering extension`);
  }
  const piReadme = readRepoFile("packages/pi-acp/README.md");
  assert.ok(piReadme.includes("AgentSession.steer"), "Pi README must document native pi steering");
  const piSpec = readRepoFile("docs/specs/pi-acp-spec.md");
  assert.ok(piSpec.includes("pi.clearQueue()"), "Pi spec must document queue clearing before abort");
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
  ]);
  assert.equal(
    packageJson.dependencies["@automatalabs/codex-acp"],
    "workspace:*",
    "codex-acp is consumed as a workspace package",
  );

  for (const path of ["docs/api.md", "docs/design-notes.md"]) {
    const text = readRepoFile(path);
    for (const [packageName, version] of expected) {
      const cited = [
        ...text.matchAll(new RegExp(`${escapeRegExp(packageName)}@([^\\s\`),]+)`, "g")),
      ].map((match) => match[1]);
      assert.ok(cited.length > 0, `${path} must cite ${packageName}@${version}`);
      assert.deepEqual([...new Set(cited)], [version], `${path} ${packageName} version citations drifted`);
    }
    // A version-pinned codex-acp citation would break the automated Version PR (Changesets bumps
    // the workspace version without touching docs) — the workspace package is cited unversioned.
    assert.equal(
      /@automatalabs\/codex-acp@\d/.test(text),
      false,
      `${path} must not version-pin the workspace package @automatalabs/codex-acp`,
    );
  }
});

test("the executable Pi contract stays grounded in the frozen pi-acp spec", () => {
  const spec = readRepoFile("docs/specs/pi-acp-spec.md");
  assert.ok(spec.includes("## 5. Capability advertisement (`initialize`)"));
  assert.ok(spec.includes("## 8. Error taxonomy and pinned wire codes (`src/errors.ts`)"));
  assert.ok(spec.includes("### 9.4 Structured output through client-hosted MCP injection"));
  assert.ok(spec.includes("### 9.5 Auth (`src/auth.ts`)"));
  assert.ok(spec.includes("mcpCapabilities: { http: true, sse: true }"));
  assert.ok(!spec.includes('agentCapabilities._meta["@automatalabs/pi-acp"]'));
  assert.ok(!spec.includes("{ outputSchema: true }"));
  for (const retired of [
    /when armed[^\n]*structured-output tool/i,
    /install[^\n]*(?:inactive )?structured-output tool/i,
    /connect the request's stdio MCP servers/i,
    /configOptions:\s*\[thinkingLevelOption\]/,
    /wrapper\/translator\/structured tool/i,
    /createAgentSession\([^\n]*customTools/i,
    /arm structured output if requested/i,
    /MCP stdio client factory/i,
    /Disposal\/disconnect errors[^\n]*never mask/i,
    /observable structured-tool collision/i,
  ]) {
    assert.doesNotMatch(spec, retired, `frozen pi-acp spec retains a retired Pi mechanism: ${retired.source}`);
  }
  assert.match(spec, /MCP is connected \*\*before\*\*\s*`forkFrom`/);
  assert.match(spec, /fork allocates and\s+reserves its target id before MCP connect/);
  for (const methodId of PI_ACP_PROTOCOL_CONTRACT.authMethodIds) {
    assert.ok(spec.includes(methodId), `frozen pi-acp spec must contain auth method ${methodId}`);
  }
  for (const errorKind of PI_ACP_PROTOCOL_CONTRACT.providerErrorKinds) {
    assert.ok(spec.includes(`errorKind:"${errorKind}"`), `frozen pi-acp spec must contain errorKind ${errorKind}`);
  }
});

test("all seven public guidance files reject the retired Pi channels as whole files", () => {
  const publicGuidance = [
    "README.md",
    "docs/api.md",
    "docs/design-notes.md",
    "packages/workflows/README.md",
    "packages/pi-acp/README.md",
    "packages/acp-agents/README.md",
    "docs/specs/acp-auth-spec.md",
  ];
  const stalePiClaims = [
    /Pi[^\n]{0,160}(?:turn-level|turn params?)[^\n]{0,80}(?:_meta\.)?outputSchema/i,
    /Pi[^\n]{0,160}no MCP injection/i,
    /Codex\s*\/\s*Pi[^\n]{0,120}final text/i,
    /Pi[^\n]{0,160}(?:stdio[- ]only|only stdio)/i,
    /No `model` config option is advertised/i,
    /Pi[^\n]{0,160}(?:representative|hardcoded)[^\n]{0,80}model list/i,
    /agentCapabilities\._meta\["@automatalabs\/pi-acp"\]/,
  ];
  for (const path of publicGuidance) {
    const text = readRepoFile(path);
    for (const stale of stalePiClaims) {
      assert.doesNotMatch(text, stale, `${path} contains retired Pi guidance: ${stale.source}`);
    }
  }

  const structuredGuidance = publicGuidance.slice(0, 5);
  for (const path of structuredGuidance) {
    const text = readRepoFile(path);
    assert.match(text, /client-hosted[^\n]{0,500}(?:HTTP[^\n]{0,160})?StructuredOutput|StructuredOutput[^\n]{0,500}client-hosted/i,
      `${path} must describe Pi's client-hosted StructuredOutput capture`);
    assert.match(text, /(?:validated[^\n]{0,80})?(?:final-text|last-text)[^\n]{0,80}fallback|fallback[^\n]{0,80}(?:final-text|last-text)/i,
      `${path} must retain the common validated text fallback`);
  }
  const piReadme = readRepoFile("packages/pi-acp/README.md");
  assert.match(piReadme, /stdio, Streamable HTTP, and legacy SSE/);
  assert.match(piReadme, /completed credential- and provider-filter-aware Pi catalog/);
  assert.match(piReadme, /Client-hosted `acp` transport remains runner-owned/);
});

test("root agent entrypoints preserve planning freedom and monorepo delivery rules", () => {
  const agents = readRepoFile("AGENTS.md");
  const claude = readRepoFile("CLAUDE.md");
  const contributing = readRepoFile("CONTRIBUTING.md");
  const dependencyGate = readRepoFile("scripts/check-acp-deps.mjs");
  const codexAgents = readRepoFile("packages/codex-acp/AGENTS.md");

  assert.equal(claude.trim(), "@AGENTS.md", "CLAUDE.md must import the canonical root AGENTS.md");
  assert.ok(
    agents.includes("not an untouchable architectural constitution"),
    "root agent guidance must not fossilize implemented specs during design",
  );
  assert.ok(
    agents.includes("During design and planning") && agents.includes("During implementation"),
    "root agent guidance must distinguish planning from scoped implementation",
  );
  assert.ok(
    contributing.includes("Planning versus implemented specifications"),
    "CONTRIBUTING.md must retain the authoritative planning/implementation distinction",
  );
  assert.match(
    agents,
    /Any stale package or dependency[\s\S]*immediate maintenance work[\s\S]*separate update PR/,
    "root agent policy must make every gated update an immediate separate maintenance lane",
  );
  assert.match(
    contributing,
    /every dependency, runtime, adapter, source upstream, or workspace package checked for currency/,
    "the dependency runbook must apply immediate ownership to every gated update",
  );
  assert.ok(
    dependencyGate.includes("every stale package or dependency is immediate maintenance work"),
    "the executable gate must print the immediate-maintenance policy",
  );
  assert.ok(
    codexAgents.includes("Root monorepo, delivery, attribution, and release rules always win"),
    "the nested Codex guidance must defer to root repository policy",
  );
  assert.ok(codexAgents.includes("pnpm sync:codex-acp --pr"));
  assert.ok(codexAgents.includes("merge commit"));
  assert.ok(
    !codexAgents.includes("Releases are fully automated by release-please"),
    "upstream release-please instructions must not re-enter the vendored subtree guidance",
  );
  assert.ok(
    !codexAgents.includes("gh pr merge <pr-number> --squash"),
    "upstream squash-release instructions would destroy subtree ancestry",
  );
});

test("public package inventories cover every workspace package", () => {
  const packagesDir = join(repoRoot, "packages");
  const manifests = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      dir: entry.name,
      manifest: JSON.parse(readRepoFile(`packages/${entry.name}/package.json`)) as { name: string },
    }));

  assert.equal(manifests.length, 10, "update the documented package-count contract when the workspace changes");
  for (const path of ["README.md", "docs/api.md", "docs/design-notes.md"]) {
    const text = readRepoFile(path);
    for (const { manifest } of manifests) {
      assert.ok(text.includes(manifest.name), `${path} must inventory ${manifest.name}`);
    }
  }

  const readme = readRepoFile("README.md");
  for (const { manifest } of manifests) {
    assert.match(
      readme,
      new RegExp("^\\| \\*\\*`" + escapeRegExp(manifest.name) + "`\\*\\* \\|", "m"),
      `README.md must render ${manifest.name} in its own package-table row`,
    );
  }

  const contributing = readRepoFile("CONTRIBUTING.md");
  for (const { dir } of manifests) {
    assert.ok(contributing.includes(`packages/${dir}`), `CONTRIBUTING.md must inventory packages/${dir}`);
  }
  assert.match(contributing, /\(monorepo\) of ten packages/);
  assert.match(readRepoFile("docs/design-notes.md"), /monorepo of \*\*ten\*\* published packages/);
});

test("auth, MCP, and authoring docs retain the implemented contracts", () => {
  const packageJson = JSON.parse(readRepoFile("packages/acp-agents/package.json")) as {
    dependencies: Record<string, string>;
  };
  const authSpec = readRepoFile("docs/specs/acp-auth-spec.md");
  assert.ok(authSpec.startsWith("# ACP Authentication — Implemented End-to-End Design Record"));
  assert.ok(authSpec.includes("### 3.3 Codex — `@automatalabs/codex-acp` (workspace)"));
  assert.ok(authSpec.includes("### 4.6 Implemented test matrix (historical plan)"));
  assert.ok(authSpec.includes("### 4.7 Completed PR sequencing (historical)"));

  const mcpReadme = readRepoFile("packages/mcp-server/README.md");
  for (const contract of ["OpenCode", "`AGENTPRISM_PERSISTENCE_ROOT`", 'action:"resume"', "`author-workflow`"]) {
    assert.ok(mcpReadme.includes(contract), `MCP README must document ${contract}`);
  }
  assert.ok(
    mcpReadme.includes("config/run/resume/status/result/permissions-response/stop"),
    "MCP README must name the complete strict workflow action lifecycle",
  );
  assert.match(mcpReadme, /continue(?:s| that) the exact run ID/i);
  // Backend auth belongs to the agents' own CLI credential stores (auth/provider management lives
  // in the SDK runner APIs). Retired MCP tool names must not resurface in current-state docs.
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

  const agentReference = readRepoFile("docs/authoring/agentprism-workflow-authoring/references/api-agents.md");
  const controlFlowReference = readRepoFile("docs/authoring/agentprism-workflow-authoring/references/api-control-flow.md");
  assert.ok(agentReference.includes("| `keepSession` |"), "the exhaustive agent option table must include keepSession");
  assert.ok(controlFlowReference.includes('reason: "auth_required"'), "authoring reference must explain auth pauses");
});

test("trusted autonomous examples pin explicit modes and describe Claude auto accurately", () => {
  const trustedExamples = [
    "docs/authoring/agentprism-workflow-authoring/references/checkpoints-and-quality.md",
    "docs/authoring/agentprism-workflow-authoring/references/examples.md",
  ];
  for (const path of trustedExamples) {
    const text = readRepoFile(path);
    assert.ok(text.includes('mode: "agent"'), `${path} must pin Codex agent for trusted work`);
    assert.ok(
      text.includes('mode: "bypassPermissions"'),
      `${path} must pin Claude bypassPermissions for trusted work`,
    );
  }

  const modeGuidance = [
    "README.md",
    "packages/mcp-server/README.md",
    "docs/authoring/agentprism-workflow-authoring/SKILL.md",
    "docs/authoring/agentprism-workflow-authoring/references/models-and-config.md",
  ];
  for (const path of modeGuidance) {
    const text = readRepoFile(path);
    assert.match(text, /Claude `auto`[^\n]*(?:classifier|model classifier)/i, `${path} must describe Claude auto as classifier-driven`);
    assert.match(
      text,
      /Claude `auto`[^\n]*may (?:still )?(?:(?:ask|request) permission|ask the user)/i,
      `${path} must not describe Claude auto as permission-free`,
    );
  }
});

test("maintained examples do not reintroduce invalid agent/model contracts", () => {
  const maintainedDocs = [
    "README.md",
    "docs/api.md",
    "docs/design-notes.md",
    "packages/mcp-server/README.md",
    "packages/workflows/README.md",
    "docs/authoring/agentprism-workflow-authoring/SKILL.md",
    "docs/authoring/agentprism-workflow-authoring/references/api-agents.md",
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
