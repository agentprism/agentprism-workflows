// A MOCK ACP agent server (no network, no real Claude/Codex). Spawned by the runner
// under test via the AGENTPRISM_*_ACP_CMD/ARGS spawn override:
//   AGENTPRISM_CLAUDE_ACP_CMD=<node>  AGENTPRISM_CLAUDE_ACP_ARGS=<this file>
// It speaks REAL ACP over its own stdio using the SDK's AgentSideConnection, so the
// runner's real ClientSideConnection, draining, permission, usage, and structured-output
// plumbing are all exercised end-to-end — only the backend agent is faked.
//
// Behavior is scripted per-test via env:
//   AGENTPRISM_FAKE_SCENARIO        : JSON describing configOptions + a list of per-turn behaviors
//   AGENTPRISM_FAKE_LOG             : path to which every observed ACP request is appended as JSONL
//                                     (so the parent test can assert exactly what the agent received)
//   AGENTPRISM_FAKE_CRASH_SENTINEL  : path used to make a `{ crash: true }` turn crash EXACTLY ONCE
//                                     across process restarts (first process exits; the restart runs
//                                     the turn normally) — for the pool crash/restart test.
//
// Pool-awareness: one fake process can be REUSED across many sessions (the runner pools the
// process and opens a fresh session per agent() call), so newSession() hands out a UNIQUE
// sessionId each time and the process logs a `__start`/`__exit` lifecycle marker so the test can
// prove the process was spawned once and only closed on pool dispose.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  CLIENT_METHODS,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";

const scenario = JSON.parse(process.env.AGENTPRISM_FAKE_SCENARIO ?? "{}");
const logPath = process.env.AGENTPRISM_FAKE_LOG;
const crashSentinel = process.env.AGENTPRISM_FAKE_CRASH_SENTINEL;

function record(entry) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {
    // best-effort observation channel
  }
}

function serializeError(error) {
  if (error && typeof error === "object") {
    const out = {
      name: typeof error.name === "string" ? error.name : "Error",
      message: typeof error.message === "string" ? error.message : String(error),
    };
    if ("code" in error) out.code = error.code;
    if ("data" in error) out.data = error.data;
    return out;
  }
  return { name: "Error", message: String(error) };
}

// Lifecycle markers so the test can assert ONE spawn and a clean close on dispose.
record({ method: "__start", pid: process.pid });
let exitRecorded = false;
function recordExit(reason) {
  if (exitRecorded) return;
  exitRecorded = true;
  record({ method: "__exit", pid: process.pid, reason });
}
process.on("exit", () => recordExit("exit"));
// A normal SIGTERM terminates without running 'exit' handlers, so record + exit explicitly.
process.on("SIGTERM", () => {
  recordExit("sigterm");
  process.exit(0);
});

const defaultConfigOptions = [
  {
    id: "model",
    type: "select",
    name: "Model",
    category: "model",
    currentValue: "default-model",
    options: [
      { value: "claude-opus-4-1", name: "Claude Opus 4.1" },
      { value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { value: "gpt-5-codex[high]", name: "GPT-5 Codex (high)" },
      { value: "default-model", name: "Default" },
    ],
  },
];

function promptText(params) {
  const blocks = Array.isArray(params.prompt) ? params.prompt : [];
  return blocks.map((block) => (block && block.type === "text" ? block.text : "")).join("");
}

function normalizeClientMethod(method) {
  switch (method) {
    case "fs/read_text_file":
      return "fs/read_text_file";
    case "fs/write_text_file":
      return "fs/write_text_file";
    case "terminal/create":
      return "terminal/create";
    case "terminal/release":
      return "terminal/release";
    default:
      return method;
  }
}

function paramsWithSession(call, sessionId) {
  return { ...(call.params ?? {}), sessionId };
}

class FakeAgent {
  constructor(conn) {
    this.conn = conn;
    this.configOptions = scenario.configOptions ?? defaultConfigOptions;
    this.turnIndex = 0;
    this.sessionCounter = 0;
    this.turnBySession = new Map();
    // Per-session cancellation: a `waitForCancel` turn parks until session/cancel arrives.
    this.cancelled = new Set();
    this.cancelWaiters = new Map();
  }

  initialize(params) {
    record({ method: "initialize", params });
    // Scenario-driven initialize response (protocolVersion + agentCapabilities + agentInfo), so a
    // capability-negotiation test can drive a mismatched protocol version, advertise mcpCapabilities,
    // or advertise the @automatalabs/codex-acp custom-capability namespace. Defaults to a capable
    // backend that advertises session/close (so the runner releases sessions without killing the
    // pooled process) — the shape every other test relies on.
    if (scenario.initialize) return scenario.initialize;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { sessionCapabilities: { close: {} } },
    };
  }

  newSession(params) {
    record({ method: "newSession", params });
    // UNIQUE per call: one pooled process serves many sessions over its lifetime.
    const sessionId = `fake-session-${(this.sessionCounter += 1)}`;
    return { sessionId, configOptions: this.configOptions };
  }

  async closeSession(params) {
    record({ method: "closeSession", params });
    const turn = this.turnBySession.get(params.sessionId);
    const postTurnClientCalls = Array.isArray(turn?.postTurnClientCalls) ? turn.postTurnClientCalls : [];
    for (const call of postTurnClientCalls) {
      await this.callClient(call, params.sessionId);
    }
    this.turnBySession.delete(params.sessionId);
    return {};
  }

  setSessionConfigOption(params) {
    record({ method: "setSessionConfigOption", params });
    // Echo the catalog back with the requested value marked current.
    this.configOptions = this.configOptions.map((opt) =>
      opt.id === params.configId ? { ...opt, currentValue: params.value } : opt,
    );
    return { configOptions: this.configOptions };
  }

  async prompt(params) {
    record({ method: "prompt", params });
    const turns = scenario.turns ?? [{ text: "ok" }];
    const turn = turns[Math.min(this.turnIndex, turns.length - 1)] ?? {};
    this.turnIndex += 1;
    this.turnBySession.set(params.sessionId, turn);

    // 0) crash path: simulate the backend process dying mid-turn (before responding). With a
    // sentinel, crash EXACTLY ONCE across restarts so the engine's retry lands on a fresh process.
    if (turn.crash) {
      if (!crashSentinel || !existsSync(crashSentinel)) {
        if (crashSentinel) {
          try {
            writeFileSync(crashSentinel, "1");
          } catch {
            // best-effort
          }
        }
        process.exit(turn.crashCode ?? 1);
      }
      // Already crashed once on a prior process: fall through and serve this turn normally.
    }

    // 0.5) cancellable turn: park until the client sends session/cancel for this session, then
    // settle the turn as "cancelled" — exactly how a real agent honors session/cancel. The PROCESS
    // stays alive (cancel does not close the connection), so the pool can reuse it afterward.
    if (turn.waitForCancel) {
      if (!this.cancelled.has(params.sessionId)) {
        await new Promise((resolve) => this.cancelWaiters.set(params.sessionId, resolve));
      }
      return { stopReason: "cancelled" };
    }

    // 1) optional permission round-trip (agent -> client request)
    if (turn.toolCall) {
      const response = await this.conn.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "tc-1",
          title: turn.toolCall.title,
          kind: turn.toolCall.kind,
          ...(turn.toolCall.meta ? { _meta: turn.toolCall.meta } : {}),
        },
        options: turn.toolCall.options ?? [
          { optionId: "allow-1", name: "Allow", kind: "allow_once" },
          { optionId: "reject-1", name: "Reject", kind: "reject_once" },
        ],
      });
      record({ method: "permissionOutcome", outcome: response.outcome });
    }

    // 2) optional client-side fs/terminal calls (agent -> client request) with responses/errors
    // logged so tests can assert the real JSON-RPC path without changing the default turn.
    const clientCalls = Array.isArray(turn.clientCalls) ? turn.clientCalls : [];
    for (const call of clientCalls) {
      await this.callClient(call, params.sessionId);
    }

    // 3) optional assistant text chunks (drained before the prompt response resolves). `echoPrompt`
    // echoes this turn's prompt text back so a concurrency test can prove per-session routing.
    const texts = turn.echoPrompt
      ? [promptText(params)]
      : turn.text === undefined
        ? []
        : Array.isArray(turn.text)
          ? turn.text
          : [turn.text];
    for (const text of texts) {
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    }

    // 4) optional usage_update notification (carries the cumulative cost)
    if (turn.usageUpdate) {
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "usage_update", ...turn.usageUpdate },
      });
    }

    // 5) optional Claude raw structured_output via the _claude/sdkMessage ext notification. The
    // real claude-agent-acp stamps the owning sessionId on it, so the runner can route the result
    // to the right session under concurrency — mirror that exactly.
    if (turn.structuredOutput !== undefined) {
      await this.conn.extNotification("_claude/sdkMessage", {
        sessionId: params.sessionId,
        message: { type: "result", subtype: "success", structured_output: turn.structuredOutput },
      });
    }

    // 6) hard failure path: reject the prompt request (provider wall / process fault).
    // Real backends (claude-agent-acp failActive / codex-acp request errors) reject with the
    // failure text carried in the JSON-RPC error MESSAGE, which is what the SDK surfaces as
    // RequestError.message on the client. Mirror that exactly so errors-map classifies it.
    if (turn.throw !== undefined) {
      throw new RequestError(turn.throwCode ?? -32000, turn.throw);
    }

    return {
      stopReason: turn.stopReason ?? "end_turn",
      ...(turn.usage ? { usage: turn.usage } : {}),
    };
  }

  async callClient(call, sessionId) {
    const clientMethod = normalizeClientMethod(call.method);
    try {
      let response;
      switch (clientMethod) {
        case "fs/read_text_file": {
          const request = paramsWithSession(call, sessionId);
          request.path ??= "/tmp/fake.txt";
          response = await this.conn.readTextFile(request);
          break;
        }
        case "fs/write_text_file": {
          const request = paramsWithSession(call, sessionId);
          request.path ??= "/tmp/fake.txt";
          request.content ??= "";
          response = await this.conn.writeTextFile(request);
          break;
        }
        case "terminal/create": {
          const request = paramsWithSession(call, sessionId);
          request.command ??= "true";
          const terminal = await this.conn.createTerminal(request);
          response = { terminalId: terminal.id };
          break;
        }
        case "terminal/release": {
          const request = paramsWithSession(call, sessionId);
          request.terminalId ??= "fake-terminal";
          response = await this.conn.request(CLIENT_METHODS.terminal_release, request);
          break;
        }
        default:
          throw new Error(`Unsupported fake client call: ${String(call.method)}`);
      }
      record({ method: "clientCall", clientMethod, label: call.label, response });
    } catch (error) {
      record({ method: "clientCall", clientMethod, label: call.label, error: serializeError(error) });
    }
  }

  cancel(params) {
    record({ method: "cancel", params });
    this.cancelled.add(params.sessionId);
    const resolve = this.cancelWaiters.get(params.sessionId);
    if (resolve) {
      this.cancelWaiters.delete(params.sessionId);
      resolve();
    }
  }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((conn) => new FakeAgent(conn), stream);
