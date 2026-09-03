import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";
import {
  INVALID_PARAMS,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  type ElicitRequest,
  type ElicitResult,
  type FetchLike,
} from "@modelcontextprotocol/client";
import type { AgentRunner, RunOptions } from "@automatalabs/shared-types";
import type { DaemonHandle } from "../src/daemon/http-daemon.js";
import { structured } from "./_harness.js";
import { connectHttp, makeProjectDir, startDaemon, waitUntil } from "./_http-harness.js";

const SCRIPT = `export const meta = {
  name: "agent-configuration-elicitation",
  description: "choose every unconfigured agent before execution",
  phases: [
    { title: "Research", detail: "Collect primary evidence." },
    { title: "Review", detail: "Check the evidence." }
  ]
};
phase("Research");
await agent("research", { label: "researcher" });
phase("Review");
return agent("review", {
  label: "reviewer",
  model: "codex/gpt-5",
  mode: "codex-authored-mode",
  configOptions: { reasoning: "medium" }
});`;

interface ObservedCall {
  model?: string;
  mode?: string;
  configOptions?: Record<string, string | boolean>;
}

/** One physical Streamable HTTP request as the SDK client actually sent it. */
interface RecordedHttpExchange {
  requestBody?: string;
  contentType: string;
  /** Response bytes received so far. Legacy SSE streams stay open until the client closes. */
  received: () => string;
}

interface JsonRpcExchangeBody {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

const ACCEPTED_CONFIGURATION = {
  action: "accept" as const,
  content: {
    agent_0_model: "codex/gpt-5",
    agent_0_provider_1_config_0: "high",
    agent_1_model: "claude/sonnet",
    agent_1_provider_0_mode: "code",
    agent_1_provider_0_config_0: true,
  },
};

/**
 * Record every request the real SDK transport issues, in send order, optionally rewriting a
 * JSON-RPC request body first. Responses are tee'd and read incrementally so the SDK still
 * consumes the original stream and an SSE stream that stays open never blocks the test.
 */
function recordingFetch(
  exchanges: RecordedHttpExchange[],
  mutateRequest?: (body: JsonRpcExchangeBody) => JsonRpcExchangeBody | undefined,
): FetchLike {
  const realFetch = globalThis.fetch;
  return async (url, init) => {
    let requestInit = init;
    if (mutateRequest && typeof init?.body === "string") {
      const mutated = mutateRequest(JSON.parse(init.body) as JsonRpcExchangeBody);
      if (mutated !== undefined) requestInit = { ...init, body: JSON.stringify(mutated) };
    }
    let received = "";
    const entry: RecordedHttpExchange = {
      requestBody: typeof requestInit?.body === "string" ? requestInit.body : undefined,
      contentType: "",
      received: () => received,
    };
    exchanges.push(entry);
    const response = await realFetch(url, requestInit);
    entry.contentType = response.headers.get("content-type") ?? "";
    const reader = response.clone().body?.getReader();
    if (reader) {
      void (async () => {
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += decoder.decode(value, { stream: true });
          }
        } catch {
          // The client aborts open streams on close(); everything received still counts.
        }
      })();
    }
    return response;
  };
}

function parseRequest(exchange: RecordedHttpExchange): JsonRpcExchangeBody {
  assert.equal(typeof exchange.requestBody, "string");
  return JSON.parse(exchange.requestBody as string) as JsonRpcExchangeBody;
}

function recordedRequests(
  exchanges: RecordedHttpExchange[],
  predicate: (body: JsonRpcExchangeBody) => boolean,
): RecordedHttpExchange[] {
  return exchanges.filter((exchange) => {
    if (exchange.requestBody === undefined) return false;
    try {
      return predicate(JSON.parse(exchange.requestBody) as JsonRpcExchangeBody);
    } catch {
      return false;
    }
  });
}

function recordedMethod(exchanges: RecordedHttpExchange[], method: string): RecordedHttpExchange[] {
  return recordedRequests(exchanges, (body) => body.method === method);
}

/** Every JSON-RPC message received so far on one response: plain JSON or an SSE stream. */
function messagesSoFar(exchange: RecordedHttpExchange): JsonRpcExchangeBody[] {
  const body = exchange.received();
  if (/text\/event-stream/.test(exchange.contentType)) {
    // Only complete events (terminated by a blank line) are parsed; the priming event the
    // SDK transport emits carries an empty data line and is skipped.
    return body
      .split(/\r?\n\r?\n/)
      .slice(0, -1)
      .map((event) =>
        event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim())
          .join("\n"),
      )
      .filter((data) => data !== "")
      .map((data) => JSON.parse(data) as JsonRpcExchangeBody);
  }
  if (body.trim() === "") return [];
  const parsed = JSON.parse(body) as JsonRpcExchangeBody | JsonRpcExchangeBody[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Messages on one response once the reply to `requestId` has arrived (tee reads are async). */
async function responseMessages(
  exchange: RecordedHttpExchange,
  requestId: string | number | undefined,
): Promise<JsonRpcExchangeBody[]> {
  await waitUntil(
    () => messagesSoFar(exchange).some((message) => message.method === undefined && message.id === requestId),
    `the JSON-RPC reply to request ${String(requestId)}`,
  );
  return messagesSoFar(exchange);
}

async function singleResponse(exchange: RecordedHttpExchange): Promise<JsonRpcExchangeBody> {
  assert.match(exchange.contentType, /application\/json/, "a modern MRTR leg answers as one JSON body");
  const messages = await responseMessages(exchange, parseRequest(exchange).id);
  assert.equal(messages.length, 1);
  return messages[0]!;
}

function structuredResult(response: JsonRpcExchangeBody): Record<string, unknown> | undefined {
  return response.result?.structuredContent as Record<string, unknown> | undefined;
}

/**
 * The server keys project state by realpath (resolveProjectDir), so look it up the same way.
 * Keying by the raw temp path would create a fresh, always-empty registry entry on hosts whose
 * tmpdir is a symlink and make every "no run yet" assertion vacuous.
 */
function persistedRunCount(daemon: DaemonHandle, projectDir: string): number {
  return daemon.projects.getOrCreate(realpathSync(projectDir)).manager.listAllRuns().length;
}

const MODERN_PROTOCOL_VERSION = "2026-07-28";

function metaProtocolVersion(body: JsonRpcExchangeBody): unknown {
  return (body.params?._meta as Record<string, unknown> | undefined)?.[PROTOCOL_VERSION_META_KEY];
}

/**
 * Prove on the wire which era a recorded connection actually spoke. `Client.getProtocolEra()` is
 * the SDK's own bookkeeping; these assertions pin the handshake and per-request envelope bytes.
 */
function assertWireEra(exchanges: RecordedHttpExchange[], era: "legacy" | "modern"): void {
  const initializes = recordedMethod(exchanges, "initialize");
  const discovers = recordedMethod(exchanges, "server/discover");
  const toolCalls = recordedMethod(exchanges, "tools/call").map(parseRequest);
  assert.ok(toolCalls.length > 0, "the connection issued at least one tools/call");
  if (era === "legacy") {
    assert.equal(initializes.length, 1, "legacy opens exactly one 2025 initialize handshake");
    assert.equal(discovers.length, 0, "legacy never probes server/discover");
    assert.match(
      String(parseRequest(initializes[0]!).params?.protocolVersion),
      /^2025-/,
      "legacy negotiates a 2025 protocol revision",
    );
    for (const call of toolCalls) {
      assert.equal(metaProtocolVersion(call), undefined, "legacy calls carry no modern request envelope");
    }
    return;
  }
  assert.equal(initializes.length, 0, "modern per-request serving has no initialize handshake");
  assert.ok(discovers.length >= 1, "the pinned modern client probes server/discover at connect");
  for (const call of toolCalls) {
    assert.equal(metaProtocolVersion(call), MODERN_PROTOCOL_VERSION, "every modern leg is stamped with the pinned revision");
  }
}

/**
 * Rewrite one field of an accepted agent-configuration answer on the wire, after the SDK client
 * has produced it: the modern retry leg's `inputResponses`, or the legacy JSON-RPC result that
 * answers the shim's `elicitation/create`. Both bypass any client-side schema checking, so the
 * server's own catalog validation is what the test exercises.
 */
function corruptAcceptedSelection(
  field: string,
  value: unknown,
  onCorrupt: () => void,
): (body: JsonRpcExchangeBody) => JsonRpcExchangeBody | undefined {
  return (body) => {
    const modernAnswer = (body.params?.inputResponses as Record<string, { action?: string; content?: Record<string, unknown> }> | undefined)
      ?.agentConfiguration;
    if (body.method === "tools/call" && modernAnswer?.action === "accept") {
      onCorrupt();
      return {
        ...body,
        params: {
          ...body.params,
          inputResponses: {
            agentConfiguration: { ...modernAnswer, content: { ...modernAnswer.content, [field]: value } },
          },
        },
      };
    }
    const legacyAnswer = body.result as { action?: string; content?: Record<string, unknown> } | undefined;
    if (body.method === undefined && legacyAnswer?.action === "accept" && legacyAnswer.content !== undefined) {
      onCorrupt();
      return { ...body, result: { ...legacyAnswer, content: { ...legacyAnswer.content, [field]: value } } };
    }
    return undefined;
  };
}

function configurableRunner(seen: ObservedCall[]): AgentRunner {
  return {
    async run(_prompt: string, options: RunOptions) {
      seen.push({
        model: options.model,
        mode: options.mode,
        configOptions: options.configOptions,
      });
      return "ok" as never;
    },
    listBackends: () => ["claude", "codex"],
    async probeConfigOptions(spec?: string) {
      const backendId = spec?.startsWith("codex") ? "codex" : "claude";
      if (backendId === "codex") {
        return {
          backendId,
          modes: null,
          options: [
            {
              id: "model",
              name: "Model",
              type: "select" as const,
              currentValue: "gpt-5",
              options: [{ value: "gpt-5", name: "GPT-5" }],
            },
            {
              id: "reasoning",
              name: "Reasoning",
              type: "select" as const,
              currentValue: "medium",
              options: [
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
              ],
            },
          ],
        };
      }
      return {
        backendId,
        modes: {
          currentModeId: "plan",
          availableModes: [
            { id: "plan", name: "Plan" },
            { id: "code", name: "Code" },
          ],
        },
        options: [
          {
            id: "model",
            name: "Model",
            type: "select" as const,
            currentValue: "sonnet",
            options: [{ value: "sonnet", name: "Sonnet" }],
          },
          { id: "fast", name: "Fast", type: "boolean" as const, currentValue: false },
        ],
      };
    },
  } as AgentRunner;
}

function acceptConfiguration(request: ElicitRequest): ElicitResult {
  const params = request.params as {
    message: string;
    requestedSchema: { required?: string[]; properties: Record<string, unknown> };
  };
  assert.match(params.message, /Research — researcher/);
  assert.match(params.message, /Collect primary evidence/);
  assert.match(params.message, /Review — reviewer/);
  assert.match(params.message, /Check the evidence/);
  assert.deepEqual(params.requestedSchema.required, ["agent_0_model", "agent_1_model"]);
  return ACCEPTED_CONFIGURATION;
}

/** The effective calls the shared handler must dispatch once ACCEPTED_CONFIGURATION is applied. */
const EXPECTED_DISPATCH: ObservedCall[] = [
  { model: "codex/gpt-5", mode: undefined, configOptions: { reasoning: "high" } },
  { model: "claude/sonnet", mode: "code", configOptions: { fast: true } },
];

for (const protocolMode of ["legacy", "modern"] as const) {
  test(`${protocolMode}: declining agent configuration prevents admission and live dispatch`, async () => {
    const seen: ObservedCall[] = [];
    const daemon = await startDaemon(configurableRunner(seen));
    const projectDir = makeProjectDir(`agent-config-decline-${protocolMode}`);
    const exchanges: RecordedHttpExchange[] = [];
    const connected = await connectHttp(daemon.url, {
      protocolMode,
      fetch: recordingFetch(exchanges),
      elicit: () => ({ action: "decline" }),
    });
    try {
      assert.equal(connected.client.getProtocolEra(), protocolMode);
      const result = await connected.client.callTool({
        name: "workflow",
        arguments: { action: "run", projectDir, script: SCRIPT },
      });
      assert.equal(result.isError, true);
      assert.match(
        String((result.content[0] as { text?: string } | undefined)?.text),
        /agent configuration was not accepted/,
      );
      assert.equal(structured(result)?.runId, undefined);
      assert.deepEqual(seen, []);
      assert.equal(connected.elicitations.length, 1);
      assert.equal(persistedRunCount(daemon, projectDir), 0);
      assertWireEra(exchanges, protocolMode);
    } finally {
      await connected.dispose();
      await daemon.close();
    }
  });
}

test("one server handler configures agents over modern MRTR legs and the legacy elicitation/create shim", async () => {
  const seen: ObservedCall[] = [];
  const daemon = await startDaemon(configurableRunner(seen));
  try {
    // ---- Modern era: pinned 2026-07-28, two physical tools/call legs -------------------
    const modernExchanges: RecordedHttpExchange[] = [];
    const modernProjectDir = makeProjectDir("agent-config-modern-wire");
    const originalArguments = { action: "run", projectDir: modernProjectDir, script: SCRIPT };
    const modern = await connectHttp(daemon.url, {
      protocolMode: "modern",
      fetch: recordingFetch(modernExchanges),
      elicit: (request) => {
        assert.deepEqual(seen, [], "the runner must not dispatch before configuration acceptance");
        assert.equal(persistedRunCount(daemon, modernProjectDir), 0, "configuration must complete before run admission");
        return acceptConfiguration(request);
      },
    });
    let modernResult;
    try {
      assert.equal(modern.client.getProtocolEra(), "modern");
      modernResult = await modern.client.callTool({
        name: "workflow",
        arguments: originalArguments,
      });
      assert.equal(modernResult.isError, false);
      assert.equal(structured(modernResult)?.status, "completed");
      assert.equal(structured(modernResult)?.result, "ok");
      assert.equal("resultType" in modernResult, false, "the Client surfaces the completed result, not the MRTR envelope");
      assert.equal(modern.elicitations.length, 1);
      assert.equal(persistedRunCount(daemon, modernProjectDir), 1, "the same registry handle sees the admitted run");
    } finally {
      await modern.dispose();
    }
    assert.deepEqual(seen, EXPECTED_DISPATCH);

    // Mirror the official TypeScript SDK MRTR E2E: assert both physical tools/call legs
    // rather than inferring retry behavior from the high-level Client result.
    assertWireEra(modernExchanges, "modern");
    const modernLegs = recordedMethod(modernExchanges, "tools/call");
    assert.equal(modernLegs.length, 2, "original leg + exactly one retry leg");
    const firstRequest = parseRequest(modernLegs[0]!);
    const retryRequest = parseRequest(modernLegs[1]!);
    assert.notEqual(firstRequest.id, retryRequest.id, "the retry must use a fresh JSON-RPC id");
    assert.equal(firstRequest.params?.requestState, undefined);
    assert.equal(firstRequest.params?.inputResponses, undefined);
    assert.deepEqual(firstRequest.params?.arguments, originalArguments);
    assert.deepEqual(retryRequest.params?.arguments, originalArguments, "the retry carries the original call arguments unchanged");

    const firstResponse = await singleResponse(modernLegs[0]!);
    assert.equal(firstResponse.id, firstRequest.id);
    assert.equal(firstResponse.result?.resultType, "input_required");
    const requestState = firstResponse.result?.requestState;
    assert.equal(typeof requestState, "string");
    const inputRequests = firstResponse.result?.inputRequests as Record<string, { method?: string; params?: unknown }>;
    assert.deepEqual(Object.keys(inputRequests), ["agentConfiguration"]);
    assert.equal(inputRequests.agentConfiguration?.method, "elicitation/create");
    const modernForm = inputRequests.agentConfiguration?.params as Record<string, unknown>;
    assert.equal(retryRequest.params?.requestState, requestState, "requestState must be echoed byte-for-byte");
    assert.deepEqual(retryRequest.params?.inputResponses, {
      agentConfiguration: ACCEPTED_CONFIGURATION,
    });

    const finalResponse = await singleResponse(modernLegs[1]!);
    assert.equal(finalResponse.id, retryRequest.id);
    assert.equal(finalResponse.error, undefined);
    assert.equal(finalResponse.result?.resultType, "complete");
    assert.equal(finalResponse.result?.isError, false);
    assert.equal(structuredResult(finalResponse)?.status, "completed");
    assert.equal(structuredResult(finalResponse)?.result, "ok");

    // ---- Legacy era: explicit 2025 handshake, one tools/call leg, server-initiated form ----
    const legacyExchanges: RecordedHttpExchange[] = [];
    const legacyProjectDir = makeProjectDir("agent-config-legacy-shim");
    const legacy = await connectHttp(daemon.url, {
      protocolMode: "legacy",
      fetch: recordingFetch(legacyExchanges),
      elicit: (request) => {
        assert.deepEqual(seen, EXPECTED_DISPATCH, "no legacy dispatch before the shimmed form is answered");
        assert.equal(persistedRunCount(daemon, legacyProjectDir), 0, "the legacy elicitation/create shim must also run before admission");
        return acceptConfiguration(request);
      },
    });
    try {
      assert.equal(legacy.client.getProtocolEra(), "legacy");
      const legacyResult = await legacy.client.callTool({
        name: "workflow",
        arguments: { action: "run", projectDir: legacyProjectDir, script: SCRIPT },
      });
      assert.equal(legacyResult.isError, false);
      assert.equal(legacy.elicitations.length, 1, "legacy must send one real elicitation/create request");
      assert.equal(structured(legacyResult)?.status, structured(modernResult)?.status);
      assert.equal(structured(legacyResult)?.result, structured(modernResult)?.result);
      assert.equal(persistedRunCount(daemon, legacyProjectDir), 1);
    } finally {
      await legacy.dispose();
    }
    assert.deepEqual(seen.slice(EXPECTED_DISPATCH.length), EXPECTED_DISPATCH, "both eras dispatch the same effective calls");

    assertWireEra(legacyExchanges, "legacy");
    const legacyLegs = recordedMethod(legacyExchanges, "tools/call");
    assert.equal(legacyLegs.length, 1, "legacy never retries tools/call");
    const legacyRequest = parseRequest(legacyLegs[0]!);
    assert.equal(legacyRequest.params?.requestState, undefined);
    assert.equal(legacyRequest.params?.inputResponses, undefined);
    assert.match(legacyLegs[0]!.contentType, /text\/event-stream/, "the legacy leg streams so the server can ask first");
    const legacyMessages = await responseMessages(legacyLegs[0]!, legacyRequest.id);
    const serverForm = legacyMessages.find((message) => message.method === "elicitation/create");
    assert.ok(serverForm, "the shim turns the same inputRequired() into a server-initiated elicitation/create on the call's own stream");
    // The shim's push leg stamps transport `_meta` (its progress token) onto the request; that is
    // JSON-RPC plumbing, not part of the form the handler built, so compare everything else.
    const { _meta: _shimTransportMeta, ...legacyForm } = serverForm.params as Record<string, unknown>;
    assert.deepEqual(
      legacyForm,
      modernForm,
      "both eras publish the identical form built by the one server handler",
    );
    const legacyTerminal = legacyMessages.find((message) => message.id === legacyRequest.id);
    assert.ok(legacyTerminal, "the single legacy leg carries the completed tool result");
    assert.equal(legacyTerminal.error, undefined);
    assert.equal(legacyTerminal.result?.resultType, undefined, "legacy results never carry the 2026 envelope");
    assert.equal(structuredResult(legacyTerminal)?.status, "completed");
    assert.equal(structuredResult(legacyTerminal)?.result, "ok");
    assert.equal(
      legacyMessages.some((message) => message.result?.resultType === "input_required"),
      false,
      "legacy clients never see input_required",
    );

    const formAnswers = recordedRequests(
      legacyExchanges,
      (body) => body.method === undefined && body.id === serverForm.id && body.result !== undefined,
    );
    assert.equal(formAnswers.length, 1, "the client answers the elicitation with one JSON-RPC result POST");
    assert.deepEqual(parseRequest(formAnswers[0]!).result, ACCEPTED_CONFIGURATION);
  } finally {
    await daemon.close();
  }
});

test("tampered agent-configuration requestState is rejected before admission or dispatch", async () => {
  const seen: ObservedCall[] = [];
  const daemon = await startDaemon(configurableRunner(seen));
  const projectDir = makeProjectDir("agent-config-tampered-state");
  const exchanges: RecordedHttpExchange[] = [];
  let tampered = false;
  const connected = await connectHttp(daemon.url, {
    protocolMode: "modern",
    fetch: recordingFetch(exchanges, (body) => {
      const requestState = body.params?.requestState;
      if (body.method !== "tools/call" || typeof requestState !== "string") return undefined;
      const index = Math.floor(requestState.length / 2);
      const replacement = requestState[index] === "A" ? "B" : "A";
      tampered = true;
      return {
        ...body,
        params: {
          ...body.params,
          requestState: `${requestState.slice(0, index)}${replacement}${requestState.slice(index + 1)}`,
        },
      };
    }),
    elicit: acceptConfiguration,
  });
  try {
    await assert.rejects(
      connected.client.callTool({
        name: "workflow",
        arguments: { action: "run", projectDir, script: SCRIPT },
      }),
      (error: unknown) => {
        assert.ok(ProtocolError.isInstance(error), `expected a JSON-RPC ProtocolError, got ${String(error)}`);
        assert.equal(error.code, INVALID_PARAMS);
        assert.match(error.message, /requestState/);
        return true;
      },
    );
    assert.equal(tampered, true);
    assert.equal(connected.elicitations.length, 1);
    assert.deepEqual(seen, []);
    assert.equal(persistedRunCount(daemon, projectDir), 0);

    assertWireEra(exchanges, "modern");
    const legs = recordedMethod(exchanges, "tools/call");
    assert.equal(legs.length, 2, "the client does not retry after the signed state is rejected");
    assert.equal((await singleResponse(legs[0]!)).result?.resultType, "input_required");
    const rejected = await singleResponse(legs[1]!);
    assert.equal(rejected.result, undefined);
    assert.equal(rejected.error?.code, INVALID_PARAMS);
  } finally {
    await connected.dispose();
    await daemon.close();
  }
});

test("a changed provider catalog re-elicits instead of accepting a stale selection", async () => {
  const seen: ObservedCall[] = [];
  let advertisedModel = "old-model";
  const runner: AgentRunner = {
    async run(_prompt: string, options: RunOptions) {
      seen.push({ model: options.model, mode: options.mode, configOptions: options.configOptions });
      return "fresh" as never;
    },
    listBackends: () => ["claude"],
    async probeConfigOptions() {
      return {
        backendId: "claude",
        modes: null,
        options: [{
          id: "model",
          name: "Model",
          type: "select" as const,
          currentValue: advertisedModel,
          options: [{ value: advertisedModel, name: advertisedModel }],
        }],
      };
    },
  } as AgentRunner;
  const script = `export const meta = { name: "stale-agent-catalog", description: "catalog retry" };
return agent("configured", { label: "configured" });`;
  const daemon = await startDaemon(runner);
  const projectDir = makeProjectDir("agent-config-stale-catalog");
  const exchanges: RecordedHttpExchange[] = [];
  let rounds = 0;
  const connected = await connectHttp(daemon.url, {
    protocolMode: "modern",
    fetch: recordingFetch(exchanges),
    elicit: (request) => {
      rounds++;
      assert.deepEqual(seen, []);
      assert.equal(persistedRunCount(daemon, projectDir), 0);
      const expected = rounds === 1 ? "old-model" : "new-model";
      const modelField = (request.params as {
        requestedSchema: { properties: Record<string, { oneOf?: Array<{ const: string }> }> };
      }).requestedSchema.properties.agent_0_model;
      assert.deepEqual(modelField?.oneOf?.map((choice) => choice.const), [`claude/${expected}`]);
      // The catalog changes after the first form is answered but before the retry is served.
      if (rounds === 1) advertisedModel = "new-model";
      return { action: "accept", content: { agent_0_model: `claude/${expected}` } };
    },
  });
  try {
    const result = await connected.client.callTool({
      name: "workflow",
      arguments: { action: "run", projectDir, script },
    });
    assert.equal(rounds, 2, "the stale response must trigger a fresh form for the changed catalog");
    assert.equal(connected.elicitations.length, 2);
    assert.deepEqual(seen, [{ model: "claude/new-model", mode: undefined, configOptions: undefined }]);
    assert.equal(structured(result)?.status, "completed");
    assert.equal(structured(result)?.result, "fresh");
    assert.equal(persistedRunCount(daemon, projectDir), 1);

    // On the wire: leg 1 issues state A; leg 2 echoes A with the stale answer and is answered
    // with a NEW input_required carrying state B (not an error, not a run); leg 3 echoes B.
    const legs = recordedMethod(exchanges, "tools/call");
    assert.equal(legs.length, 3);
    const ids = legs.map((leg) => parseRequest(leg).id);
    assert.equal(new Set(ids).size, 3, "every leg uses a fresh id");
    const stateA = (await singleResponse(legs[0]!)).result?.requestState;
    assert.equal(typeof stateA, "string");
    const staleRetry = parseRequest(legs[1]!);
    assert.equal(staleRetry.params?.requestState, stateA);
    assert.deepEqual(staleRetry.params?.inputResponses, {
      agentConfiguration: { action: "accept", content: { agent_0_model: "claude/old-model" } },
    });
    const reissued = await singleResponse(legs[1]!);
    assert.equal(reissued.error, undefined);
    assert.equal(reissued.result?.resultType, "input_required");
    const stateB = reissued.result?.requestState;
    assert.equal(typeof stateB, "string");
    assert.notEqual(stateB, stateA, "the reissued form binds a new selection hash");
    const freshRetry = parseRequest(legs[2]!);
    assert.equal(freshRetry.params?.requestState, stateB);
    assert.deepEqual(freshRetry.params?.inputResponses, {
      agentConfiguration: { action: "accept", content: { agent_0_model: "claude/new-model" } },
    });
    assert.equal((await singleResponse(legs[2]!)).result?.resultType, "complete");
  } finally {
    await connected.dispose();
    await daemon.close();
  }
});

const INVALID_SELECTIONS = [
  { field: "agent_0_model", value: "claude/not-in-catalog", reason: /invalid provider\/model selection for agent occurrence 0/ },
  { field: "agent_1_provider_0_mode", value: "yolo", reason: /invalid mode selection for agent occurrence 1/ },
  { field: "agent_1_provider_0_config_0", value: "yes", reason: /invalid fast selection for agent occurrence 1/ },
] as const;

for (const protocolMode of ["legacy", "modern"] as const) {
  for (const invalid of INVALID_SELECTIONS) {
    test(`${protocolMode}: an accepted ${invalid.field} outside the probed catalog is rejected before admission or dispatch`, async () => {
      const seen: ObservedCall[] = [];
      const daemon = await startDaemon(configurableRunner(seen));
      const projectDir = makeProjectDir(`agent-config-invalid-${protocolMode}`);
      const exchanges: RecordedHttpExchange[] = [];
      let corrupted = 0;
      const connected = await connectHttp(daemon.url, {
        protocolMode,
        fetch: recordingFetch(exchanges, corruptAcceptedSelection(invalid.field, invalid.value, () => corrupted++)),
        elicit: acceptConfiguration,
      });
      try {
        assert.equal(connected.client.getProtocolEra(), protocolMode);
        // The handler rejects the answer with an invalid-params ProtocolError; for tools/call the
        // SDK surfaces handler failures as an isError tool result (the same contract the dual-era
        // suite pins for retried-argument drift), so the client sees a failed call, not a run.
        const result = await connected.client.callTool({
          name: "workflow",
          arguments: { action: "run", projectDir, script: SCRIPT },
        });
        assert.equal(result.isError, true);
        const text = String((result.content[0] as { text?: string } | undefined)?.text);
        assert.match(text, /Invalid workflow agent configuration response/);
        assert.match(text, invalid.reason);
        assert.equal(structured(result)?.runId, undefined);
        assert.equal(corrupted, 1, "exactly one accepted answer was rewritten on the wire");
        assert.equal(connected.elicitations.length, 1, "the server does not re-elicit after an invalid answer");
        assert.deepEqual(seen, [], "no live dispatch");
        assert.equal(persistedRunCount(daemon, projectDir), 0, "no run admitted");

        assertWireEra(exchanges, protocolMode);
        const legs = recordedMethod(exchanges, "tools/call");
        if (protocolMode === "modern") {
          assert.equal(legs.length, 2, "original leg + the rejected retry; the client does not retry again");
          assert.equal((await singleResponse(legs[0]!)).result?.resultType, "input_required");
          const rejected = await singleResponse(legs[1]!);
          assert.equal(rejected.error, undefined);
          assert.equal(rejected.result?.resultType, "complete", "the rejection is a final result, not another round");
          assert.equal(rejected.result?.isError, true);
          assert.equal(rejected.result?.structuredContent, undefined);
        } else {
          assert.equal(legs.length, 1, "legacy never retries tools/call");
          const legacyRequest = parseRequest(legs[0]!);
          const messages = await responseMessages(legs[0]!, legacyRequest.id);
          assert.equal(messages.filter((message) => message.method === "elicitation/create").length, 1);
          const terminal = messages.find((message) => message.id === legacyRequest.id);
          assert.equal(terminal?.error, undefined);
          assert.equal(terminal?.result?.isError, true);
          assert.equal(terminal?.result?.resultType, undefined, "legacy results never carry the 2026 envelope");
          assert.equal(terminal?.result?.structuredContent, undefined);
        }
      } finally {
        await connected.dispose();
        await daemon.close();
      }
    });
  }
}
