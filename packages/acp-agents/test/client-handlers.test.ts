// Client-side handler contracts: capability advertisement is pure and omission-based; runtime
// validation catches JavaScript partial terminal objects before any ACP process can be spawned.
import test from "node:test";
import assert from "node:assert/strict";
import { AcpAgentRunner, clientCapabilitiesFor, type McpHandlers, type TerminalHandlers } from "../src/index.js";

const TERMINAL_HANDLERS: TerminalHandlers = {
  createTerminal: () => ({ terminalId: "term-1" }),
  terminalOutput: () => ({ output: "", truncated: false }),
  waitForTerminalExit: () => ({ exitCode: 0 }),
  killTerminal: () => undefined,
  releaseTerminal: () => undefined,
};

const MCP_HANDLERS: McpHandlers = {
  connect: () => ({ connectionId: "mcp-1" }),
  message: () => ({ ok: true }),
  disconnect: () => undefined,
};

/** Advertised regardless of handlers: SessionHandle handles boolean config options natively. */
const BASE_CAPABILITIES = { session: { configOptions: { boolean: {} } } };

test("clientCapabilitiesFor: empty inputs advertise only the native session capabilities", () => {
  assert.deepEqual(clientCapabilitiesFor(undefined), BASE_CAPABILITIES);
  assert.deepEqual(clientCapabilitiesFor({}), BASE_CAPABILITIES);
  assert.deepEqual(clientCapabilitiesFor({ fs: {} }), BASE_CAPABILITIES);
});

test("clientCapabilitiesFor: elicitation is advertised only when requested", () => {
  assert.deepEqual(clientCapabilitiesFor(undefined, { elicitation: true }), {
    ...BASE_CAPABILITIES,
    elicitation: { form: {}, url: {} },
  });
});

test("clientCapabilitiesFor: fs flags are independent and only true flags are emitted", () => {
  assert.deepEqual(
    clientCapabilitiesFor({
      fs: { readTextFile: () => ({ content: "x" }) },
    }),
    { ...BASE_CAPABILITIES, fs: { readTextFile: true } },
  );
  assert.deepEqual(
    clientCapabilitiesFor({
      fs: { writeTextFile: () => undefined },
    }),
    { ...BASE_CAPABILITIES, fs: { writeTextFile: true } },
  );
  assert.deepEqual(
    clientCapabilitiesFor({
      fs: {
        readTextFile: () => ({ content: "x" }),
        writeTextFile: () => ({}),
      },
    }),
    { ...BASE_CAPABILITIES, fs: { readTextFile: true, writeTextFile: true } },
  );
});

test("clientCapabilitiesFor: terminal is advertised only with the full handler set", () => {
  assert.deepEqual(clientCapabilitiesFor({ terminal: TERMINAL_HANDLERS }), {
    ...BASE_CAPABILITIES,
    terminal: true,
  });
  assert.deepEqual(
    clientCapabilitiesFor({
      terminal: { ...TERMINAL_HANDLERS, releaseTerminal: undefined } as never,
    }),
    BASE_CAPABILITIES,
  );
});

test("clientCapabilitiesFor: mcp handlers do not invent a non-SDK initialize capability", () => {
  assert.deepEqual(clientCapabilitiesFor({ mcp: MCP_HANDLERS }), BASE_CAPABILITIES);
});

// §1.2 client auth advertisement gating matrix. auth is host-declared (like elicitation), so it is
// advertised regardless of fs/terminal/mcp handlers and OMITTED entirely when no gate is requested
// — the default-OFF, spec-"unsupported" baseline.
test("clientCapabilitiesFor: auth is omitted by default and when no gate is requested", () => {
  // No auth option at all (default-OFF).
  assert.equal("auth" in clientCapabilitiesFor(undefined), false);
  assert.equal(clientCapabilitiesFor(undefined).auth, undefined);
  // An all-false / empty auth object advertises nothing — the `auth` key never appears.
  for (const auth of [{}, { terminal: false }, { gateway: false }, { terminal: false, gateway: false }]) {
    const caps = clientCapabilitiesFor(undefined, { auth });
    assert.equal("auth" in caps, false, `auth omitted for ${JSON.stringify(auth)}`);
    assert.equal("_meta" in caps, false, `top-level _meta omitted for ${JSON.stringify(auth)}`);
    assert.deepEqual(caps, BASE_CAPABILITIES);
  }
});

test("clientCapabilitiesFor: terminal gate lights auth.terminal AND the top-level _meta channel", () => {
  // Lighting auth.terminal also sets top-level _meta["terminal-auth"] — the channel claude reads at
  // dist/acp-agent.js:339 and opencode at service.ts:100.
  assert.deepEqual(clientCapabilitiesFor(undefined, { auth: { terminal: true } }), {
    ...BASE_CAPABILITIES,
    auth: { terminal: true },
    _meta: { "terminal-auth": true },
  });
});

test("clientCapabilitiesFor: gateway gate lights only auth._meta.gateway, no top-level _meta", () => {
  const caps = clientCapabilitiesFor(undefined, { auth: { gateway: true } });
  assert.deepEqual(caps, { ...BASE_CAPABILITIES, auth: { _meta: { gateway: true } } });
  assert.equal("_meta" in caps, false, "gateway alone must not set the top-level terminal-auth channel");
});

test("clientCapabilitiesFor: both gates light terminal, gateway, and the terminal-auth channel", () => {
  assert.deepEqual(clientCapabilitiesFor(undefined, { auth: { terminal: true, gateway: true } }), {
    ...BASE_CAPABILITIES,
    auth: { terminal: true, _meta: { gateway: true } },
    _meta: { "terminal-auth": true },
  });
});

test("clientCapabilitiesFor: auth advertisement is independent of fs/terminal handlers", () => {
  // Host-declared, not handler-derived: the same auth block appears with or without handlers.
  assert.deepEqual(
    clientCapabilitiesFor({ terminal: TERMINAL_HANDLERS }, { auth: { gateway: true } }),
    { ...BASE_CAPABILITIES, terminal: true, auth: { _meta: { gateway: true } } },
  );
});

test("clientCapabilitiesFor: auth advertisement is a pure, connection-lifetime-fixed derivation", () => {
  // Fixedness (§1.2): the advertisement is a pure function of its options — same inputs yield deeply
  // equal but independent objects, so it is snapshotted once at initialize and never mutates in place.
  const options = { auth: { terminal: true, gateway: true } } as const;
  const first = clientCapabilitiesFor(undefined, options);
  const second = clientCapabilitiesFor(undefined, options);
  assert.deepEqual(first, second);
  assert.notEqual(first.auth, second.auth, "each call returns its own object graph");
  first.auth!.terminal = false;
  assert.equal(second.auth!.terminal, true, "mutating one result never affects another");
});

test("AcpAgentRunner rejects partial terminal handlers at construction", () => {
  assert.throws(
    () =>
      new AcpAgentRunner({
        clientHandlers: {
          terminal: {
            createTerminal: () => ({ terminalId: "term-1" }),
            terminalOutput: () => ({ output: "", truncated: false }),
          } as never,
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /clientHandlers\.terminal/);
      assert.match(error.message, /waitForTerminalExit/);
      assert.match(error.message, /killTerminal/);
      assert.match(error.message, /releaseTerminal/);
      return true;
    },
  );
});

test("AcpAgentRunner rejects partial mcp handlers at construction", () => {
  assert.throws(
    () =>
      new AcpAgentRunner({
        clientHandlers: {
          mcp: {
            connect: () => ({ connectionId: "mcp-1" }),
            message: () => ({}),
          } as never,
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /clientHandlers\.mcp/);
      assert.match(error.message, /disconnect/);
      return true;
    },
  );
});
