#!/usr/bin/env node
// Credential-free executable used by the repository-level Pi e2e. This is the real pi-acp
// transport and real AgentSession, with only Pi's documented model-runtime/stream seam injected.
// It proves the full AgentPrism -> ACP -> Pi session ladder without provider network access.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";

import { resolveDeps, runAcp } from "../../dist/lib.js";

console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

const sessionDir = mkdtempSync(join(tmpdir(), "agentprism-hermetic-pi-"));
const credentials = new InMemoryCredentialStore();
await credentials.modify("openai", async () => ({ type: "api_key", key: "hermetic-key" }));
const modelRuntime = await ModelRuntime.create({
  credentials,
  modelsPath: null,
  allowModelNetwork: false,
});
const model = {
  id: "hermetic-model",
  name: "Hermetic model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};

const createAgentSession = async (options) => {
  const cwd = options.sessionManager?.getCwd?.() ?? process.cwd();
  const settingsManager = SettingsManager.create(cwd, sessionDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: sessionDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const streamFn = () => {
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "hermetic pong" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 2,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 4,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: { ...message, content: [{ type: "text", text: "" }] },
      });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "hermetic pong",
        partial: message,
      });
      stream.push({
        type: "text_end",
        contentIndex: 0,
        content: "hermetic pong",
        partial: message,
      });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };

  const agent = new Agent({
    initialState: { model, systemPrompt: "Hermetic AgentPrism e2e", tools: [] },
    getApiKey: () => "hermetic-key",
    streamFn,
  });
  const session = new AgentSession({
    agent,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
    settingsManager,
    cwd,
    resourceLoader,
    customTools: options.customTools,
    modelRuntime,
    initialActiveToolNames: [],
  });
  return {
    session,
    extensionsResult: resourceLoader.getExtensions(),
    modelFallbackMessage: undefined,
  };
};

const deps = await resolveDeps({ modelRuntime, sessionDir, createAgentSession });
const { connection, agent } = await runAcp({ deps });
let shuttingDown;
const shutdown = (code) => {
  shuttingDown ??= (async () => {
    try {
      await agent.dispose();
    } finally {
      process.exit(code);
    }
  })();
  return shuttingDown;
};
connection.closed.then(() => shutdown(0), () => shutdown(1));
process.on("SIGTERM", () => { void shutdown(0); });
process.on("SIGINT", () => { void shutdown(0); });
process.stdin.resume();
