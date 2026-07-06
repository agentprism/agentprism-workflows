// End-to-end ACP elicitation against the fake agent. The fake sends unstable
// elicitation/create and elicitation/complete over the real SDK connection so these tests pin
// resolver precedence, initialize advertisement, final wire outcomes, and teardown settlement.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type {
  ClientCapabilities,
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import type {
  AcpElicitationCompleteEvent,
  AcpElicitationEvent,
  AcpElicitationPendingEvent,
  AcpEventContext,
} from "../src/index.js";
import { createFakeAgentHarness, waitFor, withTimeout } from "./helpers/fake-agent.js";

const MODEL = "anthropic/claude-opus-4-1";
const FORM_ACCEPT: CreateElicitationResponse = {
  action: "accept",
  content: { answer: "blue", count: 2, ok: true },
};
const SESSION_ACCEPT: CreateElicitationResponse = {
  action: "accept",
  content: { answer: "session" },
};
const RUNNER_ACCEPT: CreateElicitationResponse = {
  action: "accept",
  content: { answer: "runner" },
};
const DECLINE: CreateElicitationResponse = { action: "decline" };
const CANCEL: CreateElicitationResponse = { action: "cancel" };

interface LogEntry {
  method: string;
  params?: { clientCapabilities?: ClientCapabilities };
  request?: CreateElicitationRequest;
  response?: CreateElicitationResponse;
  notification?: CompleteElicitationNotification;
}

const harness = createFakeAgentHarness({ prefix: "acp-elicitation-" });
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);
const makeRunner = harness.makeRunner;

afterEach(async () => {
  await harness.cleanup();
});

function initializeCapabilities(log: LogEntry[]): ClientCapabilities | undefined {
  return log.find((entry) => entry.method === "initialize")?.params?.clientCapabilities;
}

function elicitationResponse(log: LogEntry[]): CreateElicitationResponse | undefined {
  return log.find((entry) => entry.method === "elicitationOutcome")?.response;
}

function formTurn(text = "done"): unknown {
  return {
    elicitation: {
      mode: "form",
      message: "Pick a value",
      schema: {
        type: "object",
        properties: {
          answer: { type: "string", title: "Answer" },
          count: { type: "integer", title: "Count" },
          ok: { type: "boolean", title: "OK" },
        },
        required: ["answer"],
      },
    },
    text,
  };
}

test("runner-wide resolver handles form elicitation and advertises capabilities", async () => {
  const { cwd, readLog } = configure({ turns: [formTurn()] });
  let seenRequest: CreateElicitationRequest | undefined;
  let seenContext: AcpEventContext | undefined;
  const eventOrder: string[] = [];
  const pendingEvents: AcpElicitationPendingEvent[] = [];
  const requestEvents: AcpElicitationEvent[] = [];
  const runner = makeRunner({
    onElicitation: (request, ctx) => {
      seenRequest = request;
      seenContext = ctx;
      return FORM_ACCEPT;
    },
  });
  runner.on("elicitation_pending", (event) => {
    eventOrder.push("elicitation_pending");
    pendingEvents.push(event);
  });
  runner.on("elicitation_request", (event) => {
    eventOrder.push("elicitation_request");
    requestEvents.push(event);
  });

  const out = await runner.run("hi", { model: MODEL, cwd, label: "ask", runId: "run-elicit-1" });

  assert.equal(out, "done");
  assert.equal(seenRequest?.mode, "form");
  assert.equal(seenRequest?.message, "Pick a value");
  assert.ok(seenContext?.sessionId, "resolver receives session context");
  assert.equal(seenContext?.backendId, "claude");
  assert.equal(seenContext?.label, "ask");
  assert.equal(seenContext?.runId, "run-elicit-1");
  assert.deepEqual(elicitationResponse(readLog()), FORM_ACCEPT);
  assert.deepEqual(initializeCapabilities(readLog())?.elicitation, { form: {}, url: {} });
  assert.deepEqual(eventOrder, ["elicitation_pending", "elicitation_request"]);
  assert.equal(pendingEvents.length, 1);
  assert.equal("outcome" in (pendingEvents[0] as unknown as Record<string, unknown>), false);
  assert.deepEqual(requestEvents.map((event) => event.outcome), [FORM_ACCEPT]);
});

test("session-scoped resolver overrides the runner-wide resolver", async () => {
  const { cwd, readLog } = configure({ turns: [formTurn()] });
  let runnerCalls = 0;
  let sessionCalls = 0;
  const runner = makeRunner({
    onElicitation: () => {
      runnerCalls += 1;
      return RUNNER_ACCEPT;
    },
  });
  const session = await runner.openSession({
    model: MODEL,
    cwd,
    onElicitation: () => {
      sessionCalls += 1;
      return SESSION_ACCEPT;
    },
  });

  try {
    const turn = await session.prompt("hi");
    assert.equal(turn.text, "done");
  } finally {
    await session.release();
  }

  assert.equal(runnerCalls, 0);
  assert.equal(sessionCalls, 1);
  assert.deepEqual(elicitationResponse(readLog()), SESSION_ACCEPT);
  assert.deepEqual(initializeCapabilities(readLog())?.elicitation, { form: {}, url: {} });
});

test("without any resolver elicitation auto-declines and is not advertised", async () => {
  const { cwd, readLog } = configure({ turns: [formTurn()] });

  const out = await makeRunner().run("hi", { model: MODEL, cwd });

  assert.equal(out, "done");
  assert.deepEqual(elicitationResponse(readLog()), DECLINE);
  assert.equal(initializeCapabilities(readLog())?.elicitation, undefined);
});

test("session cancel settles a parked elicitation as cancel and ignores late rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    const { cwd, readLog } = configure({ turns: [formTurn()] });
    let rejectResolver!: (reason: unknown) => void;
    let markResolverCalled!: () => void;
    const resolverCalled = new Promise<void>((resolve) => {
      markResolverCalled = resolve;
    });
    const runner = makeRunner({
      onElicitation: () => {
        markResolverCalled();
        return new Promise<CreateElicitationResponse>((_resolve, reject) => {
          rejectResolver = reject;
        });
      },
    });
    const session = await runner.openSession({ model: MODEL, cwd });
    const prompt = session.prompt("hi");
    prompt.catch(() => {});

    await resolverCalled;
    await session.cancel();
    await waitFor(() => elicitationResponse(readLog())?.action === "cancel");
    rejectResolver(new Error("late resolver rejection"));
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.deepEqual(elicitationResponse(readLog()), CANCEL);
    assert.deepEqual(unhandled, []);
    await withTimeout(prompt);
    await session.release();
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("rejecting resolver settles elicitation as cancel and the turn continues", async () => {
  const { cwd, readLog } = configure({ turns: [formTurn()] });
  const runner = makeRunner({
    onElicitation: async () => {
      throw new Error("resolver failed");
    },
  });

  const out = await runner.run("hi", { model: MODEL, cwd });

  assert.equal(out, "done");
  assert.deepEqual(elicitationResponse(readLog()), CANCEL);
});

test("elicitation/complete notification is emitted with correlated session context", async () => {
  const { cwd } = configure({
    turns: [
      {
        elicitation: {
          mode: "url",
          message: "Open the browser",
          elicitationId: "url-1",
          url: "https://example.test/consent",
        },
        elicitationComplete: { elicitationId: "url-1" },
        text: "done",
      },
    ],
  });
  const completeEvents: AcpElicitationCompleteEvent[] = [];
  const runner = makeRunner({ onElicitation: () => ({ action: "accept" }) });
  runner.on("elicitation_complete", (event) => completeEvents.push(event));

  const out = await runner.run("hi", { model: MODEL, cwd, label: "url-run", runId: "run-url-1" });

  assert.equal(out, "done");
  assert.equal(completeEvents.length, 1);
  assert.equal(completeEvents[0].notification.elicitationId, "url-1");
  assert.equal(completeEvents[0].backendId, "claude");
  assert.equal(completeEvents[0].label, "url-run");
  assert.equal(completeEvents[0].runId, "run-url-1");
  assert.ok(completeEvents[0].sessionId);
});
