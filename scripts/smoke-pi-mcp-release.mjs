#!/usr/bin/env node
// Post-publish release gate for the coordinated Pi MCP train. This intentionally installs the
// public artifacts into a fresh directory: workspace links cannot satisfy this check.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_PACKAGE_DIRS = Object.freeze({
  "@automatalabs/pi-acp": "packages/pi-acp",
  "@automatalabs/acp-agents": "packages/acp-agents",
  "@automatalabs/workflows": "packages/workflows",
  "@automatalabs/mcp-server": "packages/mcp-server",
});
const TARGETS = Object.freeze(Object.fromEntries(
  Object.entries(TARGET_PACKAGE_DIRS).map(([name, directory]) => {
    const manifestPath = join(repoRoot, directory, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.name, name, `${manifestPath} package name`);
    assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${name} source version`);
    return [name, manifest.version];
  }),
));
const installRoot = mkdtempSync(join(tmpdir(), "agentprism-pi-release-smoke-"));
process.once("exit", () => {
  try {
    rmSync(installRoot, { recursive: true, force: true });
  } catch {
    // Best effort: an abrupt platform-level child teardown may still own files briefly.
  }
});
const npmArgs = [
  "install",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--package-lock=false",
  "--prefix",
  installRoot,
  ...Object.entries(TARGETS).map(([name, version]) => `${name}@${version}`),
];
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", npmArgs, { stdio: "inherit" });

const installedRequire = createRequire(join(installRoot, "release-smoke.cjs"));

function packageRootFromEntry(name, entry) {
  let current = dirname(entry);
  for (;;) {
    const manifestPath = join(current, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === name) return { root: current, manifest, manifestPath };
    } catch {
      // Continue toward the install root.
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`cannot locate installed manifest for ${name}`);
    current = parent;
  }
}

function packageRoot(name, resolver = installedRequire) {
  return packageRootFromEntry(name, resolver.resolve(name));
}

function dependencyPackageRoot(name, fromRoot) {
  let current = fromRoot;
  for (;;) {
    const root = join(current, "node_modules", ...name.split("/"));
    const manifestPath = join(root, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === name) return { root, manifest, manifestPath };
    } catch {
      // Continue through the Node node_modules lookup ancestry.
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`cannot locate ${name} from ${fromRoot}`);
    current = parent;
  }
}

function packageImportEntry(found) {
  const rootExport = found.manifest.exports?.["."] ?? found.manifest.exports;
  const relative = typeof rootExport === "string"
    ? rootExport
    : rootExport?.import ?? found.manifest.module ?? found.manifest.main;
  assert.equal(typeof relative, "string", `${found.manifest.name} ESM entry`);
  return join(found.root, relative);
}

function filesUnder(root) {
  const result = [];
  const visit = (path) => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      if (statSync(child).isDirectory()) visit(child);
      else result.push(child);
    }
  };
  visit(root);
  return result;
}

const installed = new Map();
for (const [name, version] of Object.entries(TARGETS)) {
  const found = packageRoot(name);
  assert.equal(found.manifest.version, version, `${name} target version`);
  installed.set(name, found);
}
const piRoot = installed.get("@automatalabs/pi-acp").root;
const acpRoot = installed.get("@automatalabs/acp-agents").root;
const workflowsRoot = installed.get("@automatalabs/workflows").root;
const mcpRoot = installed.get("@automatalabs/mcp-server").root;
assert.equal(
  installed.get("@automatalabs/acp-agents").manifest.dependencies["@automatalabs/pi-acp"],
  TARGETS["@automatalabs/pi-acp"],
  "published acp-agents manifest targets the coordinated pi-acp release",
);
assert.equal(
  installed.get("@automatalabs/workflows").manifest.dependencies["@automatalabs/acp-agents"],
  TARGETS["@automatalabs/acp-agents"],
  "published workflows manifest targets the coordinated acp-agents release",
);
assert.equal(
  installed.get("@automatalabs/mcp-server").manifest.dependencies["@automatalabs/workflows"],
  TARGETS["@automatalabs/workflows"],
  "published mcp-server manifest targets the coordinated workflows release",
);
assert.equal(
  packageRoot("@automatalabs/pi-acp", createRequire(join(acpRoot, "release-smoke.cjs"))).manifest.version,
  TARGETS["@automatalabs/pi-acp"],
  "acp-agents resolves the coordinated Pi release",
);
assert.equal(
  packageRoot("@automatalabs/acp-agents", createRequire(join(workflowsRoot, "release-smoke.cjs"))).manifest.version,
  TARGETS["@automatalabs/acp-agents"],
  "workflows resolves the coordinated acp-agents release",
);
assert.equal(
  packageRoot("@automatalabs/workflows", createRequire(join(mcpRoot, "release-smoke.cjs"))).manifest.version,
  TARGETS["@automatalabs/workflows"],
  "mcp-server resolves the coordinated workflows release",
);

const piText = filesUnder(piRoot).map((path) => readFileSync(path, "utf8")).join("\n");
assert.doesNotMatch(piText, /__acp_structured_output/);
assert.doesNotMatch(piText, /@automatalabs\/pi-acp[^\n]{0,160}outputSchema/);
const piBackendText = readFileSync(join(acpRoot, "dist", "backends", "pi.js"), "utf8");
assert.doesNotMatch(piBackendText, /nativeStructured|outputSchema/);
const acpReadme = readFileSync(join(acpRoot, "README.md"), "utf8");
assert.match(acpReadme, /Pi\/OpenCode injected HTTP MCP tool/i);
assert.match(acpReadme, /Pi retains the common prompt\/validated-last-text fallback/i);
const authSpec = readFileSync(join(repoRoot, "docs", "specs", "acp-auth-spec.md"), "utf8");
assert.doesNotMatch(authSpec, /PI_ACP_PROTOCOL_CONTRACT\.(customCapabilityNamespace|outputSchemaKey)/);
assert.doesNotMatch(authSpec, /@automatalabs\/pi-acp[^\n]{0,160}outputSchema/);

const mcpEntry = installedRequire.resolve("@automatalabs/mcp-server");
const {
  AUTHORING_SKILL_ENTRIES,
  WORKFLOW_AUTHORING_SKILL_URI,
  authoringSkillResource,
  buildAuthoringPromptText,
} = await import(pathToFileURL(mcpEntry).href);
const authoringPrompt = buildAuthoringPromptText();
assert.ok(authoringPrompt.includes(WORKFLOW_AUTHORING_SKILL_URI));
// SEP-2640 keeps the prompt compact; the published skill now owns provider guidance.
const workflowSkill = AUTHORING_SKILL_ENTRIES.find(({ uri }) => uri === WORKFLOW_AUTHORING_SKILL_URI);
assert.ok(workflowSkill, "published workflow skill is discoverable");
const modelsUri = new URL("references/models-and-config.md", WORKFLOW_AUTHORING_SKILL_URI).href;
assert.ok(workflowSkill.resources.some(({ uri }) => uri === modelsUri));
const modelsResource = authoringSkillResource(modelsUri);
assert.equal(modelsResource.contents.length, 1);
assert.equal(modelsResource.contents[0].uri, modelsUri);
const modelGuidance = modelsResource.contents[0].text;
assert.match(modelGuidance, /Pi, OpenCode,[^\n]*StructuredOutput[^\n]*HTTP MCP support/i);
assert.match(modelGuidance, /prompt-embedded schema and validated final-text JSON fallback/i);
assert.doesNotMatch(modelGuidance, /Pi[^\n]{0,300}(native[^\n]*outputSchema|no injected MCP tool)/i);

const piCodingAgent = dependencyPackageRoot("@earendil-works/pi-coding-agent", piRoot);
const piAi = dependencyPackageRoot("@earendil-works/pi-ai", piRoot);
const piAgentCore = dependencyPackageRoot("@earendil-works/pi-agent-core", piCodingAgent.root);
const piCodingAgentEntry = packageImportEntry(piCodingAgent);
const piAiEntry = packageImportEntry(piAi);
const piAgentCoreEntry = packageImportEntry(piAgentCore);
const piAcpEntry = packageImportEntry(installed.get("@automatalabs/pi-acp"));
const fixturePath = join(installRoot, "hermetic-pi-acp.mjs");
writeFileSync(fixturePath, `#!/usr/bin/env node
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession, ModelRuntime, SessionManager } from ${JSON.stringify(pathToFileURL(piCodingAgentEntry).href)};
import { Agent } from ${JSON.stringify(pathToFileURL(piAgentCoreEntry).href)};
import { createAssistantMessageEventStream, InMemoryCredentialStore } from ${JSON.stringify(pathToFileURL(piAiEntry).href)};
import { resolveDeps, runAcp } from ${JSON.stringify(pathToFileURL(piAcpEntry).href)};
console.log = console.error;
const credentials = new InMemoryCredentialStore();
await credentials.modify("openai", async () => ({ type: "api_key", key: "hermetic-key" }));
const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
const model = { id: "release-smoke", name: "Release smoke", api: "openai-completions", provider: "openai", baseUrl: "https://example.invalid/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const createAgentSession = async (options) => {
  let callIndex = 0;
  const streamFn = (_model, context) => {
    const stream = createAssistantMessageEventStream();
    const structured = context.tools?.find((tool) => tool.name.includes("structured_output") && tool.name.endsWith("StructuredOutput"));
    const http = context.tools?.find((tool) => tool.name === "mcp__release-http__echo");
    const tool = callIndex === 0 ? (structured ?? http) : undefined;
    if (callIndex === 0 && !tool) throw new Error("release smoke expected an injected HTTP MCP tool");
    callIndex += 1;
    const message = { role: "assistant", content: tool ? [{ type: "toolCall", id: "release-smoke-call", name: tool.name, arguments: structured ? { answer: "structured-ok" } : { value: "http-ok" } }] : [{ type: "text", text: http ? "http tool complete" : "structured capture complete" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: tool ? "toolUse" : "stop", timestamp: Date.now() };
    queueMicrotask(() => { stream.push({ type: "start", partial: { ...message, content: [] } }); if (!tool) { const text = message.content[0].text; stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [{ type: "text", text: "" }] } }); stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message }); stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message }); } stream.push({ type: "done", reason: message.stopReason, message }); });
    return stream;
  };
  const agent = new Agent({ initialState: { model, systemPrompt: "release smoke", tools: [] }, getApiKey: () => "hermetic-key", streamFn });
  const cwd = options.sessionManager?.getCwd?.() ?? process.cwd();
  const session = new AgentSession({ agent, sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd), settingsManager: options.settingsManager, cwd, resourceLoader: options.resourceLoader, customTools: options.customTools, modelRuntime, initialActiveToolNames: [] });
  return { session, extensionsResult: options.resourceLoader?.getExtensions(), modelFallbackMessage: undefined };
};
const deps = await resolveDeps({ modelRuntime, sessionDir: mkdtempSync(join(fixtureRoot, "pi-release-smoke-")), createAgentSession });
const { connection, agent } = await runAcp({ deps });
let stopping;
const stop = (code) => stopping ??= agent.dispose().finally(() => process.exit(code));
connection.closed.then(() => stop(0), () => stop(1));
process.on("SIGTERM", () => { void stop(0); });
process.stdin.resume();
`);

const piAcpEnv = Object.freeze({
  AGENTPRISM_PI_ACP_CMD: process.execPath,
  AGENTPRISM_PI_ACP_ARGS: fixturePath,
});
const configStdout = execFileSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["--yes", `@automatalabs/workflows@${TARGETS["@automatalabs/workflows"]}`, "config", "pi", "--json"],
  {
    cwd: installRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...piAcpEnv,
    },
  },
);
const config = JSON.parse(configStdout);
const piConfig = config.harnessOptions.find((item) => item.backendId === "pi");
assert.equal(piConfig?.probed, true);
assert.deepEqual(piConfig.options.map((option) => option.id), ["thinkingLevel", "model"]);

const sdkRoot = dependencyPackageRoot("@modelcontextprotocol/sdk", mcpRoot).root;
const { Server } = await import(pathToFileURL(join(sdkRoot, "dist", "esm", "server", "index.js")).href);
const { StreamableHTTPServerTransport } = await import(pathToFileURL(join(sdkRoot, "dist", "esm", "server", "streamableHttp.js")).href);
const { CallToolRequestSchema, ListToolsRequestSchema } = await import(pathToFileURL(join(sdkRoot, "dist", "esm", "types.js")).href);
const mcp = new Server({ name: "release-http", version: "1.0.0" }, { capabilities: { tools: {} } });
mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "echo", inputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } } } }] }));
mcp.setRequestHandler(CallToolRequestSchema, ({ params }) => ({ content: [{ type: "text", text: String(params.arguments?.value) }] }));
const transports = new Map();
const http = createServer(async (request, response) => {
  try {
    const sessionId = request.headers["mcp-session-id"];
    let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
    if (!transport && request.method === "POST") {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => transports.set(id, transport),
      });
      transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
      await mcp.connect(transport);
    }
    if (!transport) { response.writeHead(404).end(); return; }
    await transport.handleRequest(request, response);
  } catch (error) {
    response.writeHead(500).end(error instanceof Error ? error.message : String(error));
  }
});
await new Promise((resolve, reject) => {
  http.once("error", reject);
  http.listen(0, "127.0.0.1", resolve);
});
const address = http.address();
assert.ok(address && typeof address === "object");
const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
const previousPiAcpEnv = Object.fromEntries(
  Object.keys(piAcpEnv).map((name) => [name, process.env[name]]),
);
Object.assign(process.env, piAcpEnv);

try {
  const workflowsEntry = installedRequire.resolve("@automatalabs/workflows");
  const { runDynamicWorkflow } = await import(pathToFileURL(workflowsEntry).href);
  const workflow = `export const meta = { name: "pi-release-smoke", description: "post-publish Pi MCP gate" };
const server = { type: "http", name: "release-http", url: ${JSON.stringify(mcpUrl)}, headers: [] };
const text = await agent("Call the release-http echo tool.", { model: "pi", mcpServers: [server] });
const structured = await agent("Return the schema.", { model: "pi", mcpServers: [server], schema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } } });
return { text, structured };`;
  const outcome = await runDynamicWorkflow(workflow, { cwd: installRoot });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  assert.ok(outcome.result && typeof outcome.result === "object");
  assert.deepEqual(Object.keys(outcome.result).sort(), ["structured", "text"]);
  assert.equal(outcome.result.text, "http tool complete");
  assert.ok(outcome.result.structured && typeof outcome.result.structured === "object");
  assert.deepEqual(Object.keys(outcome.result.structured), ["answer"]);
  assert.equal(outcome.result.structured.answer, "structured-ok");
} finally {
  await Promise.allSettled([...transports.values()].map((transport) => transport.close()));
  await mcp.close();
  await new Promise((resolve) => http.close(resolve));
  for (const [name, value] of Object.entries(previousPiAcpEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log("pi-mcp release smoke: ok");
