// The MCP shell's TRUST GATE for script-declared meta.backends:
//   - client WITHOUT the elicitation capability -> informative tool error naming the
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

//     AGENTPRISM_ALLOW_SCRIPT_BACKENDS env opt-in (never a silent drop, never a hang);
//   - env opt-in set -> approved headlessly, registry threaded to the runner;
//   - eliciting client: accept -> run proceeds (approval is session-sticky per spawn config —
//     the second call does NOT re-prompt); decline -> tool error naming the backend;
//   - scripts without meta.backends are untouched by the gate.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunner, RunOptions } from "@automatalabs/shared-types";

import { createWorkflowServer } from "../src/index.js";
import { makeRunner, textOf, type ToolCallResult } from "./_harness.js";

const SCRIPT_WITH_BACKENDS = [
  'export const meta = { name: "sb", description: "d", backends: { browser: { command: "browser-acp", env: { HEADLESS: "1" } } } };',
  'return await agent("p", { model: "browser" });',
].join("\n");

const PLAIN_SCRIPT = 'export const meta = { name: "plain", description: "d" };\nreturn await agent("p", { model: "claude" });';

function capturingRunner(): { runner: AgentRunner; backends: () => unknown } {
  let captured: unknown;
  const runner = makeRunner((_prompt, options: RunOptions) => {
    captured = options.backends;
    return "ok";
  });
  return { runner, backends: () => captured };
}

interface ElicitingConnection {
  client: Client;
  callWorkflow: (script: string) => Promise<ToolCallResult>;
  prompts: () => string[];
  dispose: () => Promise<void>;
}

/** Wire an in-memory client that DOES advertise elicitation, answering every request via
 *  `respond`. Mirrors _harness.connect() otherwise. */
async function connectEliciting(
  runner: AgentRunner,
  respond: (message: string) => { action: "accept" | "decline" | "cancel"; approve?: boolean },
): Promise<ElicitingConnection> {
  const server = createWorkflowServer(runner);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-server-test", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  const prompts: string[] = [];
  client.setRequestHandler('elicitation/create', async (request) => {
    const schema = request.params.requestedSchema;
    const required = schema.required ?? [];
    if (required.some((field) => field.startsWith("agent_") && field.endsWith("_model"))) {
      const content: Record<string, string> = {};
      for (const field of required) {
        const property = schema.properties[field] as { oneOf?: Array<{ const: string }> } | undefined;
        const choices = property?.oneOf ?? [];
        const preferred = choices.find((choice) => choice.const === "browser") ?? choices[0];
        if (preferred) content[field] = preferred.const;
      }
      return { action: "accept" as const, content };
    }
    prompts.push(request.params.message);
    const { action, approve } = respond(request.params.message);
    return action === "accept" ? { action, content: { approve: approve ?? true } } : { action };
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    prompts: () => prompts,
    callWorkflow: (script: string) => client.callTool({ name: "workflow", arguments: { script } }),
    async dispose() {
      await client.close();
      await server.close();
    },
  };
}

/** Non-eliciting client (capabilities: {}), same in-memory wiring. */
async function connectPlain(runner: AgentRunner) {
  const server = createWorkflowServer(runner);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-server-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    callWorkflow: (script: string) => client.callTool({ name: "workflow", arguments: { script } }),
    async dispose() {
      await client.close();
      await server.close();
    },
  };
}

afterEach(() => {
  delete process.env.AGENTPRISM_ALLOW_SCRIPT_BACKENDS;
});

test("non-eliciting client + meta.backends -> informative tool error naming the env opt-in", async () => {
  const { runner, backends } = capturingRunner();
  const conn = await connectPlain(runner);
  try {
    const res = await conn.callWorkflow(SCRIPT_WITH_BACKENDS);
    assert.equal(res.isError, true);
    assert.match(textOf(res), /does not support elicitation/);
    assert.match(textOf(res), /AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1/);
    assert.match(textOf(res), /browser/);
    assert.equal(backends(), undefined, "no run happened");
  } finally {
    await conn.dispose();
  }
});

test("env opt-in approves headlessly; the registry reaches the runner", async () => {
  process.env.AGENTPRISM_ALLOW_SCRIPT_BACKENDS = "1";
  const { runner, backends } = capturingRunner();
  const conn = await connectPlain(runner);
  try {
    const res = await conn.callWorkflow(SCRIPT_WITH_BACKENDS);
    assert.equal(res.isError, false);
    assert.deepEqual(backends(), { browser: { command: "browser-acp", env: { HEADLESS: "1" } } });
  } finally {
    await conn.dispose();
  }
});

test("eliciting client: accept -> run proceeds; approval is session-sticky (no re-prompt)", async () => {
  const { runner, backends } = capturingRunner();
  const conn = await connectEliciting(runner, () => ({ action: "accept", approve: true }));
  try {
    const first = await conn.callWorkflow(SCRIPT_WITH_BACKENDS);
    assert.equal(first.isError, false);
    assert.deepEqual(backends(), { browser: { command: "browser-acp", env: { HEADLESS: "1" } } });
    assert.equal(conn.prompts().length, 1, "one elicitation for one backend");
    assert.match(conn.prompts()[0], /browser-acp/);
    assert.match(conn.prompts()[0], /HEADLESS=1/, "env is shown — it is part of the attack surface");

    const second = await conn.callWorkflow(SCRIPT_WITH_BACKENDS);
    assert.equal(second.isError, false);
    assert.equal(conn.prompts().length, 1, "the SAME spawn config did not re-prompt");
  } finally {
    await conn.dispose();
  }
});

test("eliciting client: decline -> tool error naming the backend; the run never starts", async () => {
  const { runner, backends } = capturingRunner();
  const conn = await connectEliciting(runner, () => ({ action: "decline" }));
  try {
    const res = await conn.callWorkflow(SCRIPT_WITH_BACKENDS);
    assert.equal(res.isError, true);
    assert.match(textOf(res), /declined/);
    assert.match(textOf(res), /"browser"/);
    assert.equal(backends(), undefined);
  } finally {
    await conn.dispose();
  }
});

test("eliciting client: accept-with-approve:false is a DENY (explicit false beats accept)", async () => {
  const { runner } = capturingRunner();
  const conn = await connectEliciting(runner, () => ({ action: "accept", approve: false }));
  try {
    const res = await conn.callWorkflow(SCRIPT_WITH_BACKENDS);
    assert.equal(res.isError, true);
    assert.match(textOf(res), /declined/);
  } finally {
    await conn.dispose();
  }
});

test("scripts WITHOUT meta.backends never hit the backend-approval gate", async () => {
  const { runner, backends } = capturingRunner();
  const conn = await connectEliciting(runner, () => ({ action: "decline" }));
  try {
    const res = await conn.callWorkflow(PLAIN_SCRIPT);
    assert.equal(res.isError, false);
    assert.equal(conn.prompts().length, 0);
    assert.equal(backends(), undefined);
  } finally {
    await conn.dispose();
  }
});
