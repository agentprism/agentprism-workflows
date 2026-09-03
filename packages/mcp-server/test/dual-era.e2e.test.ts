import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/client";

import { structured } from "./_harness.js";
import {
  connectHttp,
  gatedRunner,
  makeProjectDir,
  startDaemon,
  waitUntil,
} from "./_http-harness.js";
import { EXTENSION_ID } from "../src/mcp-apps.js";
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
    }
    const listed = await connected.client.listTools();
    const tools = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(tools, ["docs", "repl", "workflow", "workflow-events", "workflow-runs"]);
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
      status: structured(result)?.status,
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
    assert.deepEqual(modern.tools, legacy.tools);
    assert.deepEqual(
      modern.workflowInputSchema,
      legacy.workflowInputSchema,
      "legacy and modern discovery publish the same discriminated workflow schema",
    );
    const published = modern.workflowInputSchema as { oneOf?: unknown[]; properties?: unknown };
    assert.equal(published.oneOf?.length, 7);
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
    assert.equal((response.result?.structuredContent as Record<string, unknown> | undefined)?.status, "completed");
    assert.equal(daemon.sessions.size, 0);
  } finally {
    await daemon.close();
  }
});

test("modern input_required resumes a durable workflow checkpoint while legacy behavior remains available", async () => {
  const daemon = await startDaemon(okRunner());
  const projectDir = makeProjectDir("dual-era-checkpoint");
  const connected = await connectHttp(daemon.url, {
    protocolMode: "modern",
    uiCapability: "absent",
    elicit: () => ({ action: "accept", content: { choice: "alpha" } }),
  });
  try {
    const script = `export const meta = { name: "modern-checkpoint", description: "modern checkpoint" };
return await checkpoint("Pick one", { kind: "select", choices: ["alpha", "beta"], default: "beta" });`;
    const result = await connected.client.callTool({
      name: "workflow",
      arguments: { action: "run", script, projectDir },
    });
    assert.equal(result.isError, false);
    assert.equal(structured(result)?.status, "completed");
    assert.equal(structured(result)?.result, "alpha");
    assert.equal(connected.elicitations.length, 1);
    const request = connected.elicitations[0];
    assert.ok(request && "requestedSchema" in request.params);
    assert.deepEqual(request.params.requestedSchema.properties.choice?.enum, ["alpha", "beta"]);
  } finally {
    await connected.dispose();
    await daemon.close();
  }
});

for (const protocolMode of ["legacy", "modern"] as const) {
  test(`${protocolMode} foreground permission elicitation continues the original run call`, async () => {
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
        const configuration = acceptAgentConfiguration(request);
        return configuration
          ? { action: "accept", content: configuration }
          : { action: "accept", content: { optionId: "allow_for_session" } };
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
      assert.equal(structured(terminal)?.status, "completed");
      assert.equal(structured(terminal)?.result, "allow_for_session,allow_for_session");
      assert.equal(connected.elicitations.length, 3, "agent configuration plus two live permissions");
      assert.deepEqual(broker.list(structured(terminal)?.runId as string), []);
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
        arguments: { action: "run", script, projectDir, background: true },
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

test("modern input_required enforces script-backend approval before admission", async () => {
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
      const configuration = acceptAgentConfiguration(request);
      return configuration
        ? { action: "accept", content: configuration }
        : { action: "accept", content: { approve: true } };
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
    assert.equal(structured(result)?.status, "completed");
    assert.deepEqual(capturedBackends, { browser: { command: "browser-acp" } });
    assert.equal(connected.elicitations.length, 2);
    assert.ok(connected.elicitations.some((request) => /browser-acp/.test(request.params.message)));
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
    const script = `export const meta = { name: "modern-events", description: "modern events" };
return await agent("wait", { label: "wait" });`;
    const accepted = await connected.client.callTool({
      name: "workflow",
      arguments: { action: "run", script, projectDir, background: true },
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

test("modern checkpoint requestState applies the authored default after its deadline", async () => {
  const daemon = await startDaemon(okRunner());
  const projectDir = makeProjectDir("dual-era-checkpoint-timeout");
  const script = `export const meta = { name: "modern-timeout", description: "modern timeout" };
return await checkpoint("Continue?", { kind: "confirm", default: false, timeoutMs: 5 });`;
  const args = { action: "run", script, projectDir };
  try {
    const first = await rawModernToolCall(daemon.url, 1, args);
    assert.equal(first.result?.resultType, "input_required");
    const requestState = first.result?.requestState;
    assert.equal(typeof requestState, "string");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const completed = await rawModernToolCall(daemon.url, 2, args, {
      requestState: requestState as string,
      inputResponses: { checkpoint: { action: "accept", content: { approve: true } } },
    });
    assert.equal((completed.result?.structuredContent as Record<string, unknown> | undefined)?.result, false);
  } finally {
    await daemon.close();
  }
});

test("modern checkpoint continuation uses the admitted script when scriptPath later changes", async () => {
  const daemon = await startDaemon(okRunner());
  const projectDir = makeProjectDir("dual-era-script-path-drift");
  const scriptPath = join(projectDir, "checkpoint.workflow.js");
  const original = `export const meta = { name: "path-checkpoint", description: "path checkpoint" };
return await checkpoint("Continue?", { kind: "confirm" });`;
  writeFileSync(scriptPath, original, "utf8");
  const args = { action: "run", scriptPath, projectDir };
  try {
    const first = await rawModernToolCall(daemon.url, 1, args);
    const requestState = first.result?.requestState;
    assert.equal(typeof requestState, "string");
    writeFileSync(
      scriptPath,
      `export const meta = { name: "mutated", description: "must not execute" }; return "mutated";`,
      "utf8",
    );
    const completed = await rawModernToolCall(daemon.url, 2, args, {
      requestState: requestState as string,
      inputResponses: { checkpoint: { action: "accept", content: { approve: true } } },
    });
    assert.equal(completed.error, undefined);
    const result = completed.result?.structuredContent as Record<string, unknown> | undefined;
    assert.equal(result?.status, "completed");
    assert.equal(result?.result, true);
    assert.equal(result?.scriptSource, "stored");
  } finally {
    await daemon.close();
  }
});

test("modern requestState survives daemon replacement and rejects tampering", async () => {
  const projectDir = makeProjectDir("dual-era-request-state");
  const script = `export const meta = { name: "restart-checkpoint", description: "restart checkpoint" };
return await checkpoint("Continue?", { kind: "confirm", default: false });`;
  const args = { action: "run", script, projectDir };
  const firstDaemon = await startDaemon(okRunner());
  const first = await rawModernToolCall(firstDaemon.url, 1, args);
  const requestState = first.result?.requestState;
  assert.equal(first.result?.resultType, "input_required");
  assert.equal(typeof requestState, "string");
  await firstDaemon.close();

  const successor = await startDaemon(okRunner());
  try {
    const completed = await rawModernToolCall(successor.url, 2, args, {
      requestState: requestState as string,
      inputResponses: { checkpoint: { action: "accept", content: { approve: true } } },
    });
    assert.equal(completed.error, undefined);
    assert.equal((completed.result?.structuredContent as Record<string, unknown> | undefined)?.status, "completed");
    assert.equal((completed.result?.structuredContent as Record<string, unknown> | undefined)?.result, true);

    const tamperIndex = Math.floor((requestState as string).length / 2);
    const current = (requestState as string)[tamperIndex];
    const tampered =
      `${(requestState as string).slice(0, tamperIndex)}${current === "A" ? "B" : "A"}` +
      (requestState as string).slice(tamperIndex + 1);
    const rejected = await rawModernToolCall(successor.url, 3, args, {
      requestState: tampered,
      inputResponses: { checkpoint: { action: "accept", content: { approve: true } } },
    });
    assert.equal(rejected.error?.code, -32602);

    const wrongArguments = await rawModernToolCall(successor.url, 4, {
      ...args,
      script: `${script}\n// changed`,
    }, {
      requestState: requestState as string,
      inputResponses: { checkpoint: { action: "accept", content: { approve: true } } },
    });
    assert.equal(wrongArguments.result?.isError, true);
    assert.match(JSON.stringify(wrongArguments.result?.content), /arguments do not match/);
  } finally {
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
          assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["docs", "repl", "workflow"]);
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
