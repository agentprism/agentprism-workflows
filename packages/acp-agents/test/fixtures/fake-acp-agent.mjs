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
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  CLIENT_METHODS,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const scenario = JSON.parse(process.env.AGENTPRISM_FAKE_SCENARIO ?? "{}");
const logPath = process.env.AGENTPRISM_FAKE_LOG;
const crashSentinel = process.env.AGENTPRISM_FAKE_CRASH_SENTINEL;
const authOnceSentinel = process.env.AGENTPRISM_FAKE_AUTH_ONCE_SENTINEL;
const hasScenarioModes = Object.prototype.hasOwnProperty.call(scenario, "modes");
const hasLifecycleSupport = scenario.lifecycleSupport === true;
const hasLoadSessionSupport = scenario.loadSessionSupport ?? hasLifecycleSupport;
const hasResumeSessionSupport = scenario.resumeSessionSupport ?? hasLifecycleSupport;
const hasMcpAcpSupport = scenario.mcpAcpSupport === true;
const hasMcpHttpSupport = scenario.mcpHttpSupport === true;
const hasProviderSupport = scenario.providersSupport === true || Object.prototype.hasOwnProperty.call(scenario, "providers");
const hasLogoutSupport = scenario.logoutSupport === true || Object.prototype.hasOwnProperty.call(scenario, "logout");

function record(entry) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
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

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function scenarioModesFor(block) {
  if (block && Object.prototype.hasOwnProperty.call(block, "modes")) return clone(block.modes);
  return hasScenarioModes ? clone(scenario.modes) : undefined;
}

function scenarioConfigOptionsFor(block, fallback) {
  return block && Object.prototype.hasOwnProperty.call(block, "configOptions")
    ? clone(block.configOptions)
    : clone(fallback);
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
  if (scenario.ignoreShutdown === true) {
    record({ method: "__sigterm", pid: process.pid });
    return;
  }
  recordExit("sigterm");
  process.exit(0);
});
const stdinKeepAlive = setInterval(() => {}, 1 << 30);
process.stdin.on("end", () => {
  if (scenario.ignoreShutdown === true) {
    record({ method: "__stdin_end", pid: process.pid });
    return;
  }
  clearInterval(stdinKeepAlive);
  recordExit("stdin-end");
  process.exit(0);
});

// Lifecycle teardown regressions use this intentionally detached Pi-like command process. It
// ignores SIGTERM and sits in a separate process group, so killing only the ACP server would
// orphan it unless the parent snapshots and force-kills the whole descendant tree.
if (scenario.stubbornPiChild === true) {
  const stubbornChild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });
  stubbornChild.unref();
  record({ method: "__stubborn_pi_child", childPid: stubbornChild.pid });
}

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
      { value: "gpt-5.6-luna[high]", name: "GPT-5.6 Luna (high)" },
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

function elicitationRequestFromScenario(elicitation, sessionId) {
  const mode = elicitation.mode ?? "form";
  const base = {
    sessionId,
    mode,
    message: elicitation.message ?? "Input required",
    ...(elicitation.meta ? { _meta: elicitation.meta } : {}),
  };
  if (mode === "url") {
    return {
      ...base,
      elicitationId: elicitation.elicitationId ?? "fake-elicitation",
      url: elicitation.url ?? "https://example.test/elicitation",
    };
  }
  if (mode === "form") {
    return {
      ...base,
      requestedSchema: elicitation.schema ?? {
        type: "object",
        properties: { answer: { type: "string", title: "Answer" } },
        required: ["answer"],
      },
    };
  }
  return { ...base, ...(elicitation.params ?? {}) };
}

function elicitationCompleteFromScenario(complete) {
  if (typeof complete === "string") return { elicitationId: complete };
  return {
    elicitationId: complete?.elicitationId ?? "fake-elicitation",
    ...(complete?.meta ? { _meta: complete.meta } : {}),
  };
}

function structuredToolCallsFor(turn) {
  if (Array.isArray(turn.structuredToolCalls)) return turn.structuredToolCalls;
  if (Object.prototype.hasOwnProperty.call(turn, "structuredToolCall")) return [turn.structuredToolCall];
  return [];
}

function structuredToolArgumentsFor(flow, prompt) {
  if (flow?.argumentsFromPromptJson === true) {
    const marker = flow.promptMarker ?? "STRUCTURED_OUTPUT_PAYLOAD:";
    const line = prompt.split("\n").find((entry) => entry.startsWith(marker));
    if (!line) throw new Error(`structured output payload marker not found: ${marker}`);
    return JSON.parse(line.slice(marker.length));
  }
  return flow && Object.prototype.hasOwnProperty.call(flow, "arguments") ? flow.arguments : flow;
}

function structuredOutputServerFor(servers, flow) {
  const wanted = typeof flow?.serverName === "string" ? flow.serverName : undefined;
  const candidates = servers.filter((server) => {
    if (!server || server.type !== "http") return false;
    if (wanted) return server.name === wanted;
    return typeof server.name === "string" && server.name.startsWith("structured_output");
  });
  return candidates.at(-1);
}

class FakeAgent {
  constructor(conn) {
    this.conn = conn;
    this.configOptions = scenario.configOptions ?? defaultConfigOptions;
    this.turnIndex = 0;
    this.sessionCounter = 0;
    this.turnBySession = new Map();
    this.modesBySession = new Map();
    this.mcpServersBySession = new Map();
    // Per-session cancellation: a `waitForCancel` turn parks until session/cancel arrives.
    this.cancelled = new Set();
    this.cancelWaiters = new Map();
  }

  async initialize(params) {
    record({ method: "initialize", params });
    if (typeof scenario.initializeDelayMs === "number" && scenario.initializeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, scenario.initializeDelayMs));
    }
    if (scenario.initializeThrow) {
      throw new RequestError(scenario.initializeThrowCode ?? -32603, String(scenario.initializeThrow));
    }
    // Scenario-driven initialize response (protocolVersion + agentCapabilities + agentInfo), so a
    // capability-negotiation test can drive a mismatched protocol version, advertise mcpCapabilities,
    // or advertise the @automatalabs/codex-acp custom-capability namespace. Defaults to a capable
    // backend that advertises session/close (so the runner releases sessions without killing the
    // pooled process) — the shape every other test relies on.
    if (scenario.initialize) {
      const response = clone(scenario.initialize);
      if (Array.isArray(scenario.authMethods)) response.authMethods = clone(scenario.authMethods);
      return response;
    }
    const sessionCapabilities = {
      close: {},
      ...(hasLifecycleSupport ? { fork: {}, list: {}, delete: {}, additionalDirectories: {} } : {}),
      ...(hasResumeSessionSupport ? { resume: {} } : {}),
    };
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        ...(hasLoadSessionSupport ? { loadSession: true } : {}),
        sessionCapabilities,
        ...(hasMcpAcpSupport || hasMcpHttpSupport
          ? {
              mcpCapabilities: {
                ...(hasMcpAcpSupport ? { acp: true } : {}),
                ...(hasMcpHttpSupport ? { http: true } : {}),
              },
            }
          : {}),
        ...(hasProviderSupport ? { providers: {} } : {}),
        ...(hasLogoutSupport ? { auth: { logout: {} } } : {}),
      },
      ...(Array.isArray(scenario.authMethods) ? { authMethods: clone(scenario.authMethods) } : {}),
    };
  }

  async extMethod(method, params) {
    const fixture = scenario.extensionRequest;
    record({ method: "extensionRequest", extensionMethod: method, params });
    if (fixture?.method === method) {
      if (typeof fixture.delayMs === "number" && fixture.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, fixture.delayMs));
      }
      if (fixture.exitBeforeResponse === true) process.exit(17);
      if (fixture.error) {
        throw new RequestError(
          fixture.error.code,
          fixture.error.message,
          clone(fixture.error.data),
        );
      }
      return clone(fixture.response);
    }
    throw RequestError.methodNotFound(method);
  }

  async extNotification(method, params) {
    record({ method: "extensionNotification", extensionMethod: method, params });
  }

  newSession(params) {
    record({ method: "newSession", params });
    this.newSessionAttempts = (this.newSessionAttempts ?? 0) + 1;
    const authRequiredCount = typeof scenario.authRequiredOnNewSessionCount === "number"
      ? scenario.authRequiredOnNewSessionCount
      : scenario.authRequiredOnNewSession
        ? Number.POSITIVE_INFINITY
        : 0;
    const authRequiredOnceAlreadyFired = scenario.authRequiredOnNewSessionOnce && authOnceSentinel && existsSync(authOnceSentinel);
    if (this.newSessionAttempts <= authRequiredCount && !authRequiredOnceAlreadyFired) {
      if (scenario.authRequiredOnNewSessionOnce && authOnceSentinel) {
        try {
          writeFileSync(authOnceSentinel, "1");
        } catch {
          // best-effort cross-process test latch
        }
      }
      throw RequestError.authRequired(
        clone(scenario.authRequiredData),
        typeof scenario.authRequiredMessage === "string" ? scenario.authRequiredMessage : undefined,
      );
    }
    // UNIQUE per call: one pooled process serves many sessions over its lifetime.
    // Process-unique ids: real ACP agents mint globally-unique session ids, and the per-session
    // event filter depends on that — two fixture processes must never collide on an id.
    const sessionId = `fake-session-${process.pid}-${(this.sessionCounter += 1)}`;
    const modes = hasScenarioModes ? clone(scenario.modes) : undefined;
    if (modes) this.modesBySession.set(sessionId, modes);
    this.mcpServersBySession.set(sessionId, clone(params.mcpServers ?? []));
    return {
      sessionId,
      configOptions: this.configOptions,
      ...(hasScenarioModes ? { modes } : {}),
    };
  }

  async loadSession(params) {
    record({ method: "loadSession", params });
    const load = scenario.loadSession ?? {};
    if (load.delayMs) await new Promise((resolve) => setTimeout(resolve, load.delayMs));
    if (load.authRequired) throw RequestError.authRequired(clone(load.throwData), load.throw);
    if (load.throw) throw new RequestError(load.throwCode ?? -32603, load.throw, clone(load.throwData));
    const modes = scenarioModesFor(load);
    if (modes) this.modesBySession.set(params.sessionId, modes);
    const configOptions = scenarioConfigOptionsFor(load, this.configOptions);
    this.configOptions = configOptions;

    if (load.toolCall) {
      const response = await this.conn.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "load-tc-1",
          title: load.toolCall.title,
          kind: load.toolCall.kind,
          ...(load.toolCall.meta ? { _meta: load.toolCall.meta } : {}),
        },
        options: load.toolCall.options ?? [
          { optionId: "allow-1", name: "Allow", kind: "allow_once" },
          { optionId: "reject-1", name: "Reject", kind: "reject_once" },
        ],
      });
      record({ method: "permissionOutcome", phase: "load", outcome: response.outcome });
    }

    const replay =
      load.replay === undefined
        ? []
        : Array.isArray(load.replay)
          ? load.replay
          : [load.replay];
    for (const entry of replay) {
      // A plain string replays an assistant message chunk (the historical
      // shape); an object may carry `{ role: "user"|"assistant", text }` so
      // a test can replay the founding turn's PROMPT (user_message_chunk)
      // alongside its outcome — the transcript shape the re-attach arm's
      // observability probe keys on, mirroring how a real agent replays
      // persisted history (getSessionMessages → toAcpNotifications).
      if (entry && typeof entry === "object") {
        const role = entry.role === "user" ? "user" : "assistant";
        await this.conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
            content: { type: "text", text: entry.text },
          },
        });
      } else {
        await this.conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: String(entry) },
          },
        });
      }
    }
    for (const update of Array.isArray(load.updates) ? load.updates : []) {
      await this.conn.sessionUpdate({ sessionId: params.sessionId, update: clone(update) });
    }
    // Post-response LIVE continuation: a real agent whose founding turn is still in flight
    // keeps streaming session/update notifications AFTER the session/load response (the
    // replay ends at the last persisted chunk; the live turn continues). The re-attach arm
    // observes these on the same update stream — the transcript probe must see them arrive
    // AFTER the load response to tell "still running" from "completed while down". The
    // response is returned immediately; the continuation streams in the background.
    if (Array.isArray(load.continue)) {
      for (const entry of load.continue) {
        const afterMs = typeof entry.afterMs === "number" ? entry.afterMs : 0;
        setTimeout(async () => {
          try {
            await this.conn.sessionUpdate({ sessionId: params.sessionId, update: clone(entry.update) });
          } catch {
            // The client may have disconnected before the continuation fired; best-effort.
          }
        }, afterMs);
      }
    }
    return {
      configOptions,
      ...(modes ? { modes } : {}),
    };
  }

  async resumeSession(params) {
    record({ method: "resumeSession", params });
    const resume = scenario.resumeSession ?? {};
    if (resume.delayMs) await new Promise((resolve) => setTimeout(resolve, resume.delayMs));
    if (resume.authRequired) throw RequestError.authRequired(clone(resume.throwData), resume.throw);
    if (resume.throw) throw new RequestError(resume.throwCode ?? -32603, resume.throw, clone(resume.throwData));
    const modes = scenarioModesFor(resume);
    if (modes) this.modesBySession.set(params.sessionId, modes);
    const configOptions = scenarioConfigOptionsFor(resume, this.configOptions);
    this.configOptions = configOptions;
    return {
      configOptions,
      ...(modes ? { modes } : {}),
    };
  }

  async unstable_forkSession(params) {
    record({ method: "forkSession", params });
    const fork = scenario.forkSession ?? {};

    if (fork.permissionBeforeError) {
      const toolCall = fork.permissionBeforeError;
      const response = await this.conn.requestPermission({
        sessionId: toolCall.sessionId ?? params.sessionId,
        toolCall: {
          toolCallId: "fork-tc-1",
          title: toolCall.title ?? "Fork permission",
          kind: toolCall.kind ?? "read",
        },
        options: toolCall.options ?? [
          { optionId: "allow-1", name: "Allow", kind: "allow_once" },
          { optionId: "reject-1", name: "Reject", kind: "reject_once" },
        ],
      });
      record({ method: "permissionOutcome", phase: "fork", outcome: response.outcome });
    }

    if (fork.throw) throw new RequestError(fork.throwCode ?? -32603, fork.throw);

    const sessionId =
      typeof fork.sessionId === "string"
        ? fork.sessionId
        : `fake-fork-${process.pid}-${(this.sessionCounter += 1)}`;
    const modes = scenarioModesFor(fork);
    if (modes) this.modesBySession.set(sessionId, modes);
    const configOptions = scenarioConfigOptionsFor(fork, this.configOptions);
    this.configOptions = configOptions;
    this.mcpServersBySession.set(sessionId, clone(params.mcpServers ?? []));
    return {
      sessionId,
      configOptions,
      ...(modes ? { modes } : {}),
    };
  }

  listSessions(params) {
    record({ method: "listSessions", params });
    return clone(scenario.listSessions ?? { sessions: [] });
  }

  deleteSession(params) {
    record({ method: "deleteSession", params });
    return clone(scenario.deleteSession ?? {});
  }

  authenticate(params) {
    if (scenario.authenticateHandler === false) throw RequestError.methodNotFound("authenticate");
    record({ method: "authenticate", params });
    const auth = scenario.authenticate ?? {};
    if (auth.throw) throw new RequestError(auth.throwCode ?? -32000, auth.throw);
    return clone(auth.response ?? {});
  }

  unstable_listProviders(params) {
    if (scenario.providersHandler === false || scenario.providers?.listHandler === false) {
      throw RequestError.methodNotFound("providers/list");
    }
    record({ method: "listProviders", params });
    return clone(scenario.providers?.list ?? { providers: [] });
  }

  unstable_setProvider(params) {
    if (scenario.providersHandler === false || scenario.providers?.setHandler === false) {
      throw RequestError.methodNotFound("providers/set");
    }
    record({ method: "setProvider", params });
    return clone(scenario.providers?.set ?? {});
  }

  unstable_disableProvider(params) {
    if (scenario.providersHandler === false || scenario.providers?.disableHandler === false) {
      throw RequestError.methodNotFound("providers/disable");
    }
    record({ method: "disableProvider", params });
    return clone(scenario.providers?.disable ?? {});
  }

  logout(params) {
    if (scenario.logoutHandler === false) throw RequestError.methodNotFound("logout");
    record({ method: "logout", params });
    const logout = scenario.logout ?? {};
    if (logout.throw) throw new RequestError(logout.throwCode ?? -32000, logout.throw);
    return clone(logout.response ?? {});
  }

  async closeSession(params) {
    record({ method: "closeSession", params });
    const turn = this.turnBySession.get(params.sessionId);
    const close = turn?.close ?? scenario.close ?? {};
    if (typeof close.delayMs === "number" && close.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, close.delayMs));
    }
    const postTurnClientCalls = Array.isArray(turn?.postTurnClientCalls) ? turn.postTurnClientCalls : [];
    for (const call of postTurnClientCalls) {
      await this.callClient(call, params.sessionId);
    }
    const postCloseUpdates = Array.isArray(turn?.postCloseUpdates) ? turn.postCloseUpdates : [];
    for (const update of postCloseUpdates) {
      await this.conn.sessionUpdate({ sessionId: params.sessionId, update: clone(update) });
    }
    if (close.throw) {
      throw new RequestError(close.throwCode ?? -32603, close.throw, clone(close.throwData));
    }
    this.turnBySession.delete(params.sessionId);
    this.modesBySession.delete(params.sessionId);
    this.mcpServersBySession.delete(params.sessionId);
    return {};
  }

  setSessionMode(params) {
    record({ method: "setSessionMode", params });
    const modes = this.modesBySession.get(params.sessionId);
    const ids = modes?.availableModes?.map((mode) => mode.id) ?? [];
    if (!modes || !ids.includes(params.modeId)) {
      throw RequestError.invalidParams(params, `unknown session mode: ${params.modeId}`);
    }
    this.modesBySession.set(params.sessionId, { ...modes, currentModeId: params.modeId });
    return {};
  }

  setSessionConfigOption(params) {
    record({ method: "setSessionConfigOption", params });
    if (scenario.setConfigOptionError) {
      throw RequestError.invalidParams(params, String(scenario.setConfigOptionError));
    }
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
    if (typeof turn.delayMs === "number" && turn.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
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

    // 1.5) optional elicitation round-trip (agent -> client request) and URL-complete
    // notification. This exercises the unstable SDK methods over the real connection.
    if (turn.elicitation) {
      const request = elicitationRequestFromScenario(turn.elicitation, params.sessionId);
      const response = await this.conn.unstable_createElicitation(request);
      record({ method: "elicitationOutcome", request, response });
    }
    if (turn.elicitationComplete) {
      const notification = elicitationCompleteFromScenario(turn.elicitationComplete);
      await this.conn.unstable_completeElicitation(notification);
      record({ method: "elicitationComplete", notification });
    }

    // 1.75) optional MCP-over-ACP flow. The fake is the AGENT: it asks the client to connect
    // to a client-declared ACP MCP server, sends one opaque MCP payload, and optionally leaves the
    // connection live so release/death teardown can prove the client closes it.
    if (turn.mcpOverAcp) {
      await this.callMcpOverAcp(turn.mcpOverAcp);
    }

    const structuredToolCalls = structuredToolCallsFor(turn);
    for (const call of structuredToolCalls) {
      await this.callStructuredOutputTool(call, params.sessionId, promptText(params));
    }

    // 2) optional client-side fs/terminal calls (agent -> client request) with responses/errors
    // logged so tests can assert the real JSON-RPC path without changing the default turn.
    const clientCalls = Array.isArray(turn.clientCalls) ? turn.clientCalls : [];
    for (const call of clientCalls) {
      await this.callClient(call, params.sessionId);
    }

    // 3) optional current-mode update, then assistant text chunks (drained before the prompt
    // response resolves). `echoPrompt`
    // echoes this turn's prompt text back so a concurrency test can prove per-session routing.
    const currentModeId =
      typeof turn.currentModeId === "string"
        ? turn.currentModeId
        : typeof turn.currentModeUpdate?.currentModeId === "string"
          ? turn.currentModeUpdate.currentModeId
          : undefined;
    if (currentModeId) {
      const modes = this.modesBySession.get(params.sessionId);
      if (modes) this.modesBySession.set(params.sessionId, { ...modes, currentModeId });
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId },
      });
    }
    // 3.5) optional raw session updates emitted VERBATIM (in order) before the text chunks —
    // lets a test interleave tool_call / thought / plan events with message chunks to exercise
    // final-message segmentation (schema-shaped progress messages before the final answer).
    const rawUpdates = Array.isArray(turn.updates) ? turn.updates : [];
    for (const update of rawUpdates) {
      await this.conn.sessionUpdate({ sessionId: params.sessionId, update: clone(update) });
    }
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
    // Real backends reject with a JSON-RPC RequestError. `throwData` mirrors their structured
    // adapter payloads (e.g. Claude's errorKind or Codex's codexErrorInfo); the message remains
    // available for display.
    // Default to -32603 (internal error): a generic prompt failure is NOT auth. The SDK reserves
    // -32000 EXCLUSIVELY for authRequired, so tests that want the auth path use authRequired* or
    // pass an explicit throwCode; a bare generic failure must never carry -32000.
    if (turn.throw !== undefined) {
      throw new RequestError(turn.throwCode ?? -32603, turn.throw, clone(turn.throwData));
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

  async callMcpOverAcp(flow) {
    const serverId = flow.serverId ?? "fake-acp-mcp";
    let connectionId;
    try {
      const request = {
        serverId,
        ...(flow.connectMeta ? { _meta: flow.connectMeta } : {}),
      };
      const response = await this.conn.request(CLIENT_METHODS.mcp_connect, request);
      connectionId = response?.connectionId;
      record({ method: "mcpConnect", label: flow.label, request, response });
    } catch (error) {
      record({ method: "mcpConnect", label: flow.label, error: serializeError(error) });
      return;
    }

    if (flow.message !== false) {
      try {
        const request = {
          connectionId,
          method: flow.method ?? "tools/list",
          ...(Object.prototype.hasOwnProperty.call(flow, "params") ? { params: flow.params } : {}),
          ...(flow.messageMeta ? { _meta: flow.messageMeta } : {}),
        };
        const response = await this.conn.request(CLIENT_METHODS.mcp_message, request);
        record({ method: "mcpMessage", label: flow.label, request, response });
      } catch (error) {
        record({ method: "mcpMessage", label: flow.label, error: serializeError(error) });
      }
    }

    if (flow.disconnect === false) return;
    try {
      const request = {
        connectionId,
        ...(flow.disconnectMeta ? { _meta: flow.disconnectMeta } : {}),
      };
      const response = await this.conn.request(CLIENT_METHODS.mcp_disconnect, request);
      record({ method: "mcpDisconnect", label: flow.label, request, response });
    } catch (error) {
      record({ method: "mcpDisconnect", label: flow.label, error: serializeError(error) });
    }
  }

  async callStructuredOutputTool(flow, sessionId, prompt) {
    const servers = this.mcpServersBySession.get(sessionId) ?? [];
    const server = structuredOutputServerFor(servers, flow);
    if (!server) {
      record({
        method: "structuredToolCall",
        label: flow?.label,
        error: { name: "Error", message: "structured output MCP server not found" },
      });
      return;
    }

    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    const client = new Client({ name: "fake-acp-agent", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      if (flow?.listTools) {
        const tools = await client.listTools();
        record({ method: "structuredToolList", label: flow?.label, serverName: server.name, tools });
      }
      const response = await client.callTool({
        name: flow?.toolName ?? "StructuredOutput",
        arguments: structuredToolArgumentsFor(flow, prompt),
      });
      record({ method: "structuredToolCall", label: flow?.label, serverName: server.name, response });
    } catch (error) {
      record({ method: "structuredToolCall", label: flow?.label, serverName: server.name, error: serializeError(error) });
    } finally {
      try {
        await client.close();
      } catch {
        // best-effort test client teardown
      }
    }
  }

  cancel(params) {
    record({ method: "cancel", params });
    const turn = this.turnBySession.get(params.sessionId);
    if (turn?.ignoreCancel) return;
    this.cancelled.add(params.sessionId);
    const resolve = this.cancelWaiters.get(params.sessionId);
    if (resolve) {
      this.cancelWaiters.delete(params.sessionId);
      resolve();
    }
  }
}

process.stdin.resume();
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = new AgentSideConnection((conn) => new FakeAgent(conn), stream);
void connection;
