// A profile-less, spec-CONFORMANT ACP agent fixture (§3.5) — the executable proof of Principle 1.
// It carries NO AuthProfile: the runner drives it end-to-end through the identical dispatcher, class
// inference, advertisement, and error taxonomy that every first-class agent traverses.
//
// It advertises one method of each spec type, gated on the client capabilities the runner lights:
//   - `env_var`  "api-key" with two vars (FAKE_AUTH_TOKEN secret, FAKE_ORG optional) — always visible
//   - `agent`    "gateway" with a gateway-shaped `_meta.gateway` — visible iff auth._meta.gateway
//   - `terminal` "terminal-login" with a `_meta["terminal-auth"]` launch hint — visible iff the
//                terminal channel (auth.terminal OR _meta["terminal-auth"]) is lit
// It emits `-32000` (RequestError.authRequired) on `session/new` until authenticated, stores the
// gateway `_meta` IN-PROCESS, reads env creds from its spawn environment, persists a disk sentinel
// for the terminal/agent-login path (so a respawn inherits it), and supports `logout`.
//
// Env knobs (all optional):
//   AGENTPRISM_FAKE_AUTH_LOG        : JSONL path; every observed request is appended (pid-tagged)
//   AGENTPRISM_FAKE_AUTH_DISK       : path used as the disk-persisted-cred sentinel (terminal login)
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";

const logPath = process.env.AGENTPRISM_FAKE_AUTH_LOG;
const diskSentinel = process.env.AGENTPRISM_FAKE_AUTH_DISK;

const ENV_KEY = "FAKE_AUTH_TOKEN";
const GATEWAY_ID = "gateway";
const ENV_VAR_ID = "api-key";
const TERMINAL_ID = "terminal-login";

function record(entry) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
  } catch {
    // best-effort observation channel
  }
}

record({ method: "__start", pid: process.pid });

// Lifecycle hygiene mirroring the sibling fixture: exit cleanly on SIGTERM / stdin-end.
let exitRecorded = false;
function recordExit(reason) {
  if (exitRecorded) return;
  exitRecorded = true;
  record({ method: "__exit", pid: process.pid, reason });
}
process.on("exit", () => recordExit("exit"));
process.on("SIGTERM", () => {
  recordExit("sigterm");
  process.exit(0);
});
const keepAlive = setInterval(() => {}, 1 << 30);
process.stdin.on("end", () => {
  clearInterval(keepAlive);
  recordExit("stdin-end");
  process.exit(0);
});

function clientLightsGateway(caps) {
  return caps?.auth?._meta?.gateway === true;
}
function clientLightsTerminal(caps) {
  return caps?.auth?.terminal === true || caps?._meta?.["terminal-auth"] === true;
}

class FakeAuthAgent {
  constructor(conn) {
    this.conn = conn;
    // In-process gateway credential (dies with this process, like a real gateway cred).
    this.gatewayAuthed = false;
    this.sessionCounter = 0;
    this.clientCaps = undefined;
  }

  initialize(params) {
    record({ method: "initialize", params });
    this.clientCaps = params.clientCapabilities;
    const authMethods = [
      {
        id: ENV_VAR_ID,
        name: "API Key",
        type: "env_var",
        vars: [
          { name: ENV_KEY, label: "Fake auth token", secret: true },
          { name: "FAKE_ORG", label: "Organization", secret: false, optional: true },
        ],
        link: "https://example.test/keys",
      },
    ];
    if (clientLightsGateway(params.clientCapabilities)) {
      authMethods.push({ id: GATEWAY_ID, name: "Gateway", _meta: { gateway: { protocol: "test" } } });
    }
    if (clientLightsTerminal(params.clientCapabilities)) {
      authMethods.push({
        id: TERMINAL_ID,
        name: "Terminal Login",
        type: "terminal",
        _meta: { "terminal-auth": { command: "true", args: [], label: "Fake Login" } },
      });
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { sessionCapabilities: { close: {} }, auth: { logout: {} } },
      authMethods,
    };
  }

  // Authenticated when: an in-process gateway cred was replayed, OR the spawn env carries the key
  // (spawn-env), OR the disk sentinel exists (a terminal/agent-login persisted cred a respawn reads).
  isAuthed() {
    if (this.gatewayAuthed) return true;
    if (typeof process.env[ENV_KEY] === "string" && process.env[ENV_KEY].length > 0) return true;
    if (diskSentinel && existsSync(diskSentinel)) return true;
    return false;
  }

  authenticate(params) {
    record({ method: "authenticate", params, authed: this.isAuthed() });
    if (params.methodId === GATEWAY_ID) {
      // Store the whole request _meta in-process (never on disk) — the gateway cred lives on the
      // process and is lost on respawn, exactly like claude/codex gateway.
      this.gatewayMeta = params._meta;
      this.gatewayAuthed = true;
    } else if (params.methodId === TERMINAL_ID) {
      // A terminal/agent-login persists to the native store — model that as a disk sentinel so a
      // fresh process inherits it.
      if (diskSentinel) {
        try {
          writeFileSync(diskSentinel, "1");
        } catch {
          // best-effort
        }
      }
    }
    return {};
  }

  newSession(params) {
    record({ method: "newSession", params, pid: process.pid, authed: this.isAuthed() });
    if (!this.isAuthed()) {
      throw RequestError.authRequired(undefined, "Authentication required");
    }
    const sessionId = `fake-auth-${process.pid}-${(this.sessionCounter += 1)}`;
    return { sessionId };
  }

  async prompt(params) {
    record({ method: "prompt", params, pid: process.pid });
    await this.conn.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
    });
    return { stopReason: "end_turn" };
  }

  logout(params) {
    record({ method: "logout", params });
    // Clear the in-process gateway cred (a real agent's logout clears in-memory state); leave the
    // disk sentinel — a real logout RPC path is separate from the native store.
    this.gatewayAuthed = false;
    this.gatewayMeta = undefined;
    return {};
  }

  async closeSession(params) {
    record({ method: "closeSession", params });
    return {};
  }

  cancel(params) {
    record({ method: "cancel", params });
  }
}

process.stdin.resume();
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = new AgentSideConnection((conn) => new FakeAuthAgent(conn), stream);
void connection;
