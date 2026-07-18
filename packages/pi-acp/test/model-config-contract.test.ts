import assert from "node:assert/strict";
import test from "node:test";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { PiAcpAgent } from "../src/agent.js";
import { context, fakeDeps, fakeSession } from "./helpers/fakes.js";

const modelShape = (id: string, name = id) => ({
  id,
  name,
  api: "openai-completions" as const,
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

test("C1 real Pi model writer never publishes its configured-provider provisional snapshot", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("github-copilot", async () => ({
    type: "oauth",
    access: "fixture-access",
    refresh: "fixture-refresh",
    expires: Date.now() + 60_000,
    availableModelIds: ["allowed"],
  }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const correctiveRefresh = deferred<ReturnType<typeof modelShape>[]>();
  const setup = fakeDeps();
  setup.deps.modelRuntime = runtime;
  let provisional: readonly { id: string }[] = [];
  setup.deps.createAgentSession = async (options: CreateAgentSessionOptions) => {
    setup.createOptions.push(options);
    const control = fakeSession(options);
    setup.controls.push(control);
    control.session.bindExtensions = async () => {
      runtime.registerProvider("github-copilot", {
        models: [modelShape("allowed", "Allowed"), modelShape("filtered", "Filtered")],
        refreshModels: () => correctiveRefresh.promise,
      });
      provisional = runtime.getAvailableSnapshot();
    };
    return {
      session: control.session,
      extensionsResult: { extensions: [], errors: [], runtime: {} },
      modelFallbackMessage: undefined,
    } as never;
  };

  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  assert.deepEqual(provisional.filter((model) => model.id === "allowed" || model.id === "filtered").map(({ id }) => id), ["allowed", "filtered"]);
  const modelOption = opened.configOptions[1];
  assert.equal(modelOption?.id, "model");
  assert.equal(modelOption?.type, "select");
  assert.deepEqual(modelOption?.type === "select"
    ? modelOption.options.filter(({ value }) => value.startsWith("github-copilot/"))
    : [], [
    { value: "github-copilot/allowed", name: "Allowed" },
  ]);
  await assert.rejects(agent.setConfigOption(context({
    sessionId: opened.sessionId,
    configId: "model",
    value: "github-copilot/filtered",
  })), (error: { data?: { errorKind?: unknown } }) => error.data?.errorKind === "invalid_model");
  correctiveRefresh.resolve([modelShape("allowed", "Allowed")]);
  await agent.dispose();
});

test("C1/C2/C4 catalog order, duplicates, active-unlisted state, and first identity are exact", async () => {
  const setup = fakeDeps();
  const first = { provider: "dup", id: "same", name: "First", contextWindow: 100 };
  const second = { provider: "dup", id: "same", name: "Second", contextWindow: 200 };
  const other = { provider: "z", id: "last", name: "Last", contextWindow: 300 };
  setup.deps.modelRuntime = {
    async getAvailable() { return [first, second, other]; },
    getModel() { return undefined; },
    hasConfiguredAuth() { return true; },
  } as never;
  let selected: unknown;
  setup.deps.createAgentSession = async (options) => {
    setup.createOptions.push(options);
    const control = fakeSession({
      ...options,
      model: { provider: "historical", id: "unlisted", name: "Historical", contextWindow: 50 } as never,
    });
    setup.controls.push(control);
    control.session.setModel = async (model) => { selected = model; };
    return { session: control.session, extensionsResult: { extensions: [], errors: [], runtime: {} } } as never;
  };
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  const initial = opened.configOptions[1];
  assert.deepEqual(initial, {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: "historical/unlisted",
    options: [
      { value: "dup/same", name: "First" },
      { value: "dup/same", name: "Second" },
      { value: "z/last", name: "Last" },
    ],
  });
  const echo = await agent.setConfigOption(context({
    sessionId: opened.sessionId,
    configId: "model",
    value: "dup/same",
  }));
  assert.equal(selected, first);
  assert.deepEqual(echo.configOptions.map(({ id }) => id), ["thinkingLevel", "model"]);
  await agent.dispose();
});

test("C2 empty catalogs and C4 refresh failure are non-mutating", async () => {
  const setup = fakeDeps();
  let reads = 0;
  setup.deps.modelRuntime = {
    getAvailable() {
      reads += 1;
      if (reads === 1) return Promise.resolve([]);
      return Promise.reject(new Error("catalog refresh failed"));
    },
    getModel() { return undefined; },
    hasConfiguredAuth() { return false; },
  } as never;
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  assert.deepEqual(opened.configOptions[1], {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: "",
    options: [],
  });
  assert.equal(setup.controls[0]?.session.thinkingLevel, "medium");
  await assert.rejects(agent.setConfigOption(context({
    sessionId: opened.sessionId,
    configId: "thinkingLevel",
    value: "high",
  })), (error: { data?: { errorKind?: unknown } }) => error.data?.errorKind === "internal_error");
  assert.equal(setup.controls[0]?.session.thinkingLevel, "medium");
  await agent.dispose();
});
