import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/client";

import { structured, waitForRun } from "./_harness.js";
import {
  connectHttp,
  gatedRunner,
  makeProjectDir,
  startDaemon,
  waitUntil,
} from "./_http-harness.js";
import { EXTENSION_ID } from "../src/mcp-apps.js";
import {
  DIRECTORY_READ_METHOD,
  SKILLS_EXTENSION_ID,
  SKILLS_GET_METHOD,
  SKILLS_LIST_METHOD,
  skillsListResultSchema,
} from "../src/authoring-skills.js";
import { workflowRunEventsUri } from "../src/workflow-resources.js";
import { WorkflowPermissionBroker } from "../src/workflow-permissions.js";
import { makeRunner, okRunner } from "./_harness.js";

const SCRIPT = `export const meta = { name: "dual-era", description: "dual era smoke" }; return { ok: true };`;

interface RawJsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function rawModernRequest(
  url: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<RawJsonRpcResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
          [CLIENT_INFO_META_KEY]: { name: "raw-modern-test", version: "1" },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  });
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  return await response.json() as RawJsonRpcResponse;
}

async function rawModernToolCall(
  url: string,
  id: number,
  args: Record<string, unknown>,
  round?: { requestState: string; inputResponses: Record<string, unknown> },
  extraHeaders: Record<string, string> = {},
): Promise<RawJsonRpcResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "workflow",
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "workflow",
        arguments: args,
        ...(round ?? {}),
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
          [CLIENT_INFO_META_KEY]: { name: "raw-modern-test", version: "1" },
          [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
        },
      },
    }),
  });
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  return await response.json() as RawJsonRpcResponse;
}

function acceptAgentConfiguration(request: { params: { requestedSchema?: {
  required?: string[];
  properties: Record<string, unknown>;
} } }): Record<string, string> | undefined {
  const schema = request.params.requestedSchema;
  const required = schema?.required ?? [];
  if (!required.some((field) => field.startsWith("agent_") && field.endsWith("_model"))) return undefined;
  return Object.fromEntries(required.map((field) => {
    const property = schema?.properties[field] as { oneOf?: Array<{ const: string }> } | undefined;
    const choices = property?.oneOf ?? [];
    const selected = choices.find((choice) => choice.const.startsWith("codex")) ?? choices[0];
    assert.ok(selected);
    return [field, selected.const];
  }));
}

async function exerciseEra(
  mode: "legacy" | "modern",
  daemonUrl: string,
  projectDir: string,
): Promise<{ tools: string[]; status: unknown; workflowInputSchema: unknown }> {
  const connected = await connectHttp(daemonUrl, {
    protocolMode: mode,
    uiCapability: "matching",
  });
  try {
    assert.equal(connected.client.getProtocolEra(), mode);
    if (mode === "modern") {
      const discovered = await connected.client.discover();
      assert.ok(discovered.capabilities.extensions?.[EXTENSION_ID]);
      assert.deepEqual(
        discovered.capabilities.extensions?.[SKILLS_EXTENSION_ID],
        { directoryRead: true },
      );
      await connected.client.request(
        { method: SKILLS_LIST_METHOD, params: {} },
        skillsListResultSchema,
      );
    }
    const listed = await connected.client.listTools();
    const tools = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(tools, ["repl", "workflow", "workflow-events", "workflow-notifications", "workflow-runs", "workflow_monitor"]);
    const workflow = listed.tools.find((tool) => tool.name === "workflow");
    assert.ok(workflow);
    const panel = await connected.client.readResource({
      uri: "ui://agentprism-workflow/run-monitor.html",
    });
    assert.match((panel.contents[0] as { mimeType?: string }).mimeType ?? "", /text\/html;profile=mcp-app/);

    const result = await connected.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: SCRIPT, projectDir },
    });
    assert.equal(result.isError, false);
    return {
      tools,
      status: structured(await waitForRun(connected.client, String(structured(result)?.runId)))?.status,
      workflowInputSchema: workflow.inputSchema,
    };
  } finally {
    await connected.dispose();
  }
}

test("one daemon serves legacy sessions and modern 2026-07-28 requests through the same tool surface", async () => {
  const daemon = await startDaemon(okRunner());
  const projectDir = makeProjectDir("dual-era");
  try {
    const legacy = await exerciseEra("legacy", daemon.url, projectDir);
    const modern = await exerciseEra("modern", daemon.url, projectDir);
    const modernSkillResults = await Promise.all([
      rawModernRequest(daemon.url, 2, SKILLS_LIST_METHOD, {}),
      rawModernRequest(daemon.url, 3, SKILLS_GET_METHOD, {
        uri: "skill://agentprism-workflow-authoring/SKILL.md",
      }),
      rawModernRequest(daemon.url, 4, DIRECTORY_READ_METHOD, {
        uri: "skill://agentprism-workflow-authoring",
      }),
    ]);
    for (const result of modernSkillResults) {
      assert.equal(result.error, undefined);
      assert.equal(
        result.result?.resultType,
        "complete",
        "modern Skills Extension results carry the SEP result discriminator on the wire",
      );
    }
    assert.deepEqual(modern.tools, legacy.tools);
    assert.deepEqual(
      modern.workflowInputSchema,
      legacy.workflowInputSchema,
      "legacy and modern discovery publish the same discriminated workflow schema",
    );
    const published = modern.workflowInputSchema as { oneOf?: unknown[]; properties?: unknown };
    assert.equal(published.oneOf?.length, 8);
    assert.equal(published.properties, undefined, "neither transport regresses to the flat field superset");
    assert.equal(legacy.status, "completed");
    assert.equal(modern.status, "completed");
    assert.equal(daemon.sessions.size, 1, "only the legacy client allocates an MCP session");
  } finally {
    await daemon.close();
  }
});

test("modern envelope classification wins over a stale legacy session header", async () => {
  const daemon = await startDaemon(okRunner());
  const projectDir = makeProjectDir("dual-era-stale-session");
  try {
    const response = await rawModernToolCall(
      daemon.url,
      1,
      { action: "run", script: SCRIPT, projectDir },
      undefined,
      { "mcp-session-id": "stale-legacy-session" },
    );
    assert.equal(response.error, undefined);
    assert.equal((response.result?.structuredContent as Record<string, unknown> | undefined)?.status, "running");
    assert.equal((response.result?.structuredContent as Record<string, unknown>)?.accepted, true);
    assert.equal(daemon.sessions.size, 0);
  } finally {
    await daemon.close();
  }
});

for (const protocolMode of ["legacy", "modern"] as const) {
  test(`${protocolMode} rejects retired workflow requestState and inputResponses without a token verifier`, async () => {
    const daemon = await startDaemon(okRunner());
    const projectDir = makeProjectDir(`dual-era-retired-state-${protocolMode}`);
    const connected = await connectHttp(daemon.url, { protocolMode });
    const args = { action: "run", script: SCRIPT, projectDir };
    try {
      for (const retired of [
        { requestState: "retired-token" },
        { inputResponses: {} },
        { inputResponses: { checkpoint: { action: "accept", content: { approve: true } } } },
        { requestState: "retired-token", inputResponses: {} },
      ]) {
        const rejected = await connected.client.callTool({ name: "workflow", arguments: args, ...retired });
        assert.equal(rejected.isError, true);
        assert.match(JSON.stringify(rejected.content), /Workflow requestState\/inputResponses are retired/);
      }
      const accepted = structured(await connected.client.callTool({ name: "workflow", arguments: args }));
      assert.equal(accepted?.accepted, true);
      await waitForRun(connected.client, String(accepted?.runId), (run) => run.status === "completed");
    } finally {
      await connected.dispose();
      await daemon.close();
    }
  });

  test(`${protocolMode} checkpoint waits for an explicit run-scoped answer`, async () => {
    const daemon = await startDaemon(okRunner());
    const projectDir = makeProjectDir(`dual-era-checkpoint-${protocolMode}`);
    const connected = await connectHttp(daemon.url, {
      protocolMode, uiCapability: "absent",
      elicit: () => ({ action: "accept", content: { choice: "beta" } }),
    });
    try {
      const script = `export const meta = { name: "checkpoint", description: "explicit checkpoint" };
return await checkpoint("Pick one", { kind: "select", choices: ["alpha", "beta"] });`;
      const accepted = await connected.client.callTool({ name: "workflow", arguments: {
        action: "run", script, projectDir,
      } });
      assert.equal(structured(accepted)?.accepted, true);
      const runId = String(structured(accepted)?.runId);
      const paused = structured(await waitForRun(connected.client, runId));
      assert.equal(paused?.status, "paused");
      const outcome = paused?.outcome as { checkpointContext?: { callIndex: number; choices: string[] } };
      assert.deepEqual(outcome.checkpointContext?.choices, ["alpha", "beta"]);
      assert.equal(connected.elicitations.length, 0);
      const resumed = await connected.client.callTool({ name: "workflow", arguments: {
        action: "resume", runId,
        checkpointReplies: { [outcome.checkpointContext!.callIndex]: "alpha" },
      } });
      assert.equal(structured(resumed)?.accepted, true);
      await waitForRun(connected.client, runId, (run) => run.status === "completed");
      const exact = await connected.client.callTool({ name: "workflow", arguments: { action: "result", runId } });
      assert.equal(structured(exact)?.chunk, '"alpha"');
    } finally {
      await connected.dispose();
      await daemon.close();
    }
  });
}

for (const protocolMode of ["legacy", "modern"] as const) {
  test(`${protocolMode} live permissions are answered by later bounded run-scoped calls`, async () => {
    const broker = new WorkflowPermissionBroker();
    const runner = makeRunner(async (_prompt, options) => {
      const outcomes: string[] = [];
      for (const suffix of ["first", "second"]) {
        const response = await broker.resolver(
          {
            sessionId: `${protocolMode}-permission-session`,
            toolCall: {
              toolCallId: `${protocolMode}-permission-tool-${suffix}`,
              title: `Run ${suffix} command`,
              kind: "execute",
            },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow_for_session", name: "Allow for session", kind: "allow_always" },
            ],
          },
          {
            sessionId: `${protocolMode}-permission-session`,
            backendId: "codex",
            runId: options.runId,
            callIndex: options.callIndex,
          },
        );
        outcomes.push(response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled");
      }
      return outcomes.join(",");
    });
    const daemon = await startDaemon(runner, broker);
    const projectDir = makeProjectDir(`dual-era-permission-${protocolMode}`);
    const connected = await connectHttp(daemon.url, {
      protocolMode,
      uiCapability: "absent",
      elicit: (request) => {
        assert.equal(acceptAgentConfiguration(request), undefined, "the authored model needs no configuration form");
        return { action: "accept", content: { optionId: "allow_for_session" } };
      },
    });
    try {
      const script = `export const meta = { name: "${protocolMode}-permission", description: "permission" };
return await agent("work", { label: "worker", model: "codex" });`;
      const terminal = await connected.client.callTool({
        name: "workflow",
        arguments: { action: "run", script, projectDir },
      });
      assert.equal(terminal.isError, false, JSON.stringify(terminal.content));
      assert.equal(structured(terminal)?.accepted, true);
      const runId = String(structured(terminal)?.runId);
      for (let index = 0; index < 2; index++) {
        await waitUntil(() => broker.has(runId), `${protocolMode} permission ${index}`);
        const observed = structured(await connected.client.callTool({ name: "workflow", arguments: { action: "status", runId } }));
        const pending = observed?.pendingPermissions as Array<{ permissionId: string }>;
        assert.equal(pending.length, 1);
        const answer = await connected.client.callTool({ name: "workflow", arguments: {
          action: "permissions-response", runId, permissionId: pending[0]!.permissionId,
          response: { outcome: { outcome: "selected", optionId: "allow_for_session" } },
        } });
        assert.equal(answer.isError, false, JSON.stringify(answer));
      }
      await waitForRun(connected.client, runId, (run) => run.status === "completed");
      const exact = await connected.client.callTool({ name: "workflow", arguments: { action: "result", runId } });
      assert.equal(structured(exact)?.chunk, '"allow_for_session,allow_for_session"');
      assert.equal(connected.elicitations.length, 0);
      assert.deepEqual(broker.list(runId), []);
    } finally {
      await connected.dispose();
      await daemon.close();
    }
  });
}

for (const protocolMode of ["legacy", "modern"] as const) {
  test(`${protocolMode} status observes but never elicits a background permission`, async () => {
    const broker = new WorkflowPermissionBroker();
    const runner = makeRunner(async (_prompt, options) => {
      const response = await broker.resolver(
        {
          sessionId: `${protocolMode}-background-permission-session`,
          toolCall: { toolCallId: `${protocolMode}-background-permission-tool`, title: "Run tests", kind: "execute" },
          options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
        },
        {
          sessionId: `${protocolMode}-background-permission-session`,
          backendId: "codex",
          runId: options.runId,
          callIndex: options.callIndex,
        },
      );
      return response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled";
    });
    const daemon = await startDaemon(runner, broker);
    const projectDir = makeProjectDir(`dual-era-status-permission-${protocolMode}`);
    let permissionForms = 0;
    const connected = await connectHttp(daemon.url, {
      protocolMode,
      uiCapability: "absent",
      elicit: (request) => {
        const configuration = acceptAgentConfiguration(request);
        if (configuration) return { action: "accept", content: configuration };
        permissionForms++;
        return { action: "accept", content: { optionId: "allow_once" } };
      },
    });
    try {
      const script = `export const meta = { name: "${protocolMode}-status-permission", description: "permission" };
return await agent("work", { label: "worker", model: "codex" });`;
      const accepted = await connected.client.callTool({
        name: "workflow",
        arguments: { action: "run", script, projectDir },
      });
      const runId = structured(accepted)?.runId as string;
      await waitUntil(() => broker.has(runId), `${protocolMode} background permission request`);

      const observed = await connected.client.callTool({
        name: "workflow",
        arguments: { action: "status", runId },
      });
      assert.equal(observed.isError, false);
      assert.equal(permissionForms, 0);
      assert.equal(structured(observed)?.pendingPermissions?.length, 1);
      const permissionId = structured(observed)?.pendingPermissions?.[0]?.permissionId;
      assert.equal(typeof permissionId, "string");
      await connected.client.callTool({
        name: "workflow",
        arguments: {
          action: "permissions-response",
          runId,
          permissionId,
          response: { outcome: { outcome: "selected", optionId: "allow_once" } },
        },
      });
    } finally {
      await connected.dispose();
      await daemon.close();
    }
  });
}

test("modern durable setup enforces script-backend approval before execution", async () => {
  let capturedBackends: unknown;
  const daemon = await startDaemon(makeRunner((_prompt, options) => {
    capturedBackends = options.backends;
    return "approved";
  }));
  const projectDir = makeProjectDir("dual-era-backend");
  const connected = await connectHttp(daemon.url, {
    protocolMode: "modern",
    uiCapability: "absent",
    elicit: (request) => {
      assert.equal(acceptAgentConfiguration(request), undefined, "the authored backend needs no configuration form");
      return { action: "accept", content: { approve: true } };
    },
  });
  try {
    const script = `export const meta = { name: "modern-backend", description: "modern backend", backends: { browser: { command: "browser-acp" } } };
return await agent("approved backend", { model: "browser" });`;
    const result = await connected.client.callTool({
      name: "workflow",
      arguments: { action: "run", script, projectDir },
    });
    assert.equal(result.isError, false);
    const runId = String(structured(result)?.runId);
    const waiting = structured(await waitForRun(connected.client, runId, (run) =>
      (run.setup as { state?: string } | undefined)?.state === "input-required"));
    const setup = waiting?.setup as { request: { id: string; kind: string; message: string } };
    assert.equal(waiting?.status, "pending");
    assert.equal(capturedBackends, undefined, "backend cannot execute before explicit approval");
    assert.equal(setup.request.kind, "backend-approval");
    assert.match(setup.request.message, /browser-acp/);
    const approved = await connected.client.callTool({ name: "workflow", arguments: {
      action: "setup-response", runId, setupId: setup.request.id,
      response: { action: "accept", content: { approve: true } },
    } });
    assert.equal(approved.isError, false, JSON.stringify(approved));
    await waitForRun(connected.client, runId, (run) => run.status === "completed");
    assert.deepEqual(capturedBackends, { browser: { command: "browser-acp" } });
    assert.equal(connected.elicitations.length, 0);
  } finally {
    await connected.dispose();
    await daemon.close();
  }
});

test("modern subscriptions/listen receives list and durable run-event updates", async () => {
  const controlled = gatedRunner();
  const daemon = await startDaemon(controlled.runner);
  const projectDir = makeProjectDir("dual-era-subscriptions");
  const connected = await connectHttp(daemon.url, {
    protocolMode: "modern",
    uiCapability: "absent",
  });
  let resourceListChanges = 0;
  connected.client.setNotificationHandler("notifications/resources/list_changed", () => {
    resourceListChanges += 1;
  });
  const listSubscription = await connected.client.listen({ resourcesListChanged: true });
  try {
    const script = `export const meta = { name: "modern-events", model: "codex", description: "modern events" };
return await agent("wait", { label: "wait" });`;
    const accepted = await connected.client.callTool({
      name: "workflow",
      arguments: { action: "run", script, projectDir },
    });
    const runId = structured(accepted)?.runId;
    assert.equal(typeof runId, "string");
    await waitUntil(() => resourceListChanges > 0, "modern resources/list_changed");

    const eventsUri = workflowRunEventsUri(runId as string);
    const eventSubscription = await connected.client.listen({ resourceSubscriptions: [eventsUri] });
    try {
      controlled.release();
      await waitUntil(
        () => connected.resourceUpdates.includes(eventsUri),
        "modern resources/updated",
      );
    } finally {
      await eventSubscription.close();
    }
  } finally {
    await listSubscription.close();
    await connected.dispose();
    await daemon.close();
  }
});

test("modern checkpoints remain unanswered after the authored timeout", async () => {
  const daemon = await startDaemon(okRunner());
  const projectDir = makeProjectDir("dual-era-checkpoint-timeout");
  const connected = await connectHttp(daemon.url, { protocolMode: "modern" });
  try {
    const script = `export const meta = { name: "modern-timeout", description: "timeout remains explicit" };
return await checkpoint("Continue?", { kind: "confirm", timeoutMs: 5 });`;
    const accepted = await connected.client.callTool({ name: "workflow", arguments: {
      action: "run", script, projectDir,
    } });
    const runId = String(structured(accepted)?.runId);
    await waitForRun(connected.client, runId);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const paused = structured(await connected.client.callTool({ name: "workflow", arguments: { action: "status", runId } }));
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.reason, "checkpoint_required");
    const outcome = paused?.outcome as { checkpointContext?: { timeoutMs: number } };
    assert.equal(outcome.checkpointContext?.timeoutMs, 5);
  } finally {
    await connected.dispose();
    await daemon.close();
  }
});

test("modern checkpoint continuation uses stored source after scriptPath changes", async () => {
  const daemon = await startDaemon(okRunner());
  const projectDir = makeProjectDir("dual-era-script-path-drift");
  const connected = await connectHttp(daemon.url, { protocolMode: "modern" });
  const scriptPath = join(projectDir, "checkpoint.workflow.js");
  const original = `export const meta = { name: "path-checkpoint", description: "path checkpoint" };
return await checkpoint("Continue?", { kind: "confirm" });`;
  writeFileSync(scriptPath, original, "utf8");
  try {
    const accepted = await connected.client.callTool({ name: "workflow", arguments: {
      action: "run", scriptPath, projectDir,
    } });
    const runId = String(structured(accepted)?.runId);
    await waitForRun(connected.client, runId);
    writeFileSync(scriptPath, `export const meta = { name: "mutated", description: "must not execute" }; return "mutated";`, "utf8");
    const resumed = await connected.client.callTool({ name: "workflow", arguments: {
      action: "resume", runId, checkpointReplies: { 0: true },
    } });
    assert.equal(structured(resumed)?.accepted, true);
    assert.equal(structured(resumed)?.scriptSource, "stored");
    await waitForRun(connected.client, runId, (run) => run.status === "completed");
    const exact = await connected.client.callTool({ name: "workflow", arguments: { action: "result", runId } });
    assert.equal(structured(exact)?.chunk, "true");
    const source = await connected.client.readResource({ uri: `workflow://runs/${runId}/script` });
    assert.equal((source.contents[0] as { text: string }).text, original);
  } finally {
    await connected.dispose();
    await daemon.close();
  }
});

test("a paused run survives daemon replacement and retired requestState is rejected", async () => {
  const projectDir = makeProjectDir("dual-era-daemon-replacement");
  const script = `export const meta = { name: "restart-checkpoint", description: "restart checkpoint" };
return await checkpoint("Continue?", { kind: "confirm" });`;
  const args = { action: "run", script, projectDir };
  const firstDaemon = await startDaemon(okRunner());
  const firstClient = await connectHttp(firstDaemon.url, { protocolMode: "modern" });
  let runId: string;
  try {
    const first = await firstClient.client.callTool({ name: "workflow", arguments: args });
    runId = String(structured(first)?.runId);
    await waitForRun(firstClient.client, runId);
  } finally {
    await firstClient.dispose();
    await firstDaemon.close();
  }
  const successor = await startDaemon(okRunner());
  const connected = await connectHttp(successor.url, { protocolMode: "modern" });
  try {
    const observed = await connected.client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    assert.equal(structured(observed)?.status, "paused", "the successor sees the exact durable pause");
    const retired = await rawModernToolCall(successor.url, 3, args, {
      requestState: "retired-token", inputResponses: { checkpoint: { action: "accept", content: { approve: true } } },
    });
    assert.equal(retired.error, undefined);
    assert.equal(retired.result?.isError, true);
    assert.match(JSON.stringify(retired.result?.content), /Workflow requestState\/inputResponses are retired/);
    const resumedArgs = { action: "resume", runId, checkpointReplies: { 0: true } };
    const resumed = await connected.client.callTool({ name: "workflow", arguments: resumedArgs });
    assert.equal(structured(resumed)?.accepted, true);
    await waitForRun(connected.client, runId, (run) => run.status === "completed");
    const repeated = await connected.client.callTool({ name: "workflow", arguments: resumedArgs });
    assert.notEqual(structured(repeated)?.accepted, true, "a completed run is not continued again");
    const exact = await connected.client.callTool({ name: "workflow", arguments: { action: "result", runId } });
    assert.equal(structured(exact)?.chunk, "true");
  } finally {
    await connected.dispose();
    await successor.close();
  }
});

test("legacy and modern requests both keep the Apps surface capability-gated", async () => {
  const daemon = await startDaemon(okRunner());
  try {
    for (const protocolMode of ["legacy", "modern"] as const) {
      for (const uiCapability of [
        "absent",
        "nonmatching",
        "missing-mime-types",
        "experimental-only",
        "malformed-string",
      ] as const) {
        const connected = await connectHttp(daemon.url, { protocolMode, uiCapability });
        try {
          const listed = await connected.client.listTools();
          assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["repl", "workflow"]);
          assert.equal(listed.tools.find((tool) => tool.name === "workflow")?._meta, undefined);
          const directAppCall = await connected.client.callTool({
            name: "workflow-events",
            arguments: { runId: "missing" },
          });
          assert.equal(directAppCall.isError, true);
          assert.match(
            String((directAppCall.content[0] as { text?: string } | undefined)?.text),
            /MCP Apps support/,
          );
          await assert.rejects(
            connected.client.readResource({ uri: "ui://agentprism-workflow/run-monitor.html" }),
            /not found|Invalid params/i,
          );
        } finally {
          await connected.dispose();
        }
      }
    }
  } finally {
    await daemon.close();
  }
});
