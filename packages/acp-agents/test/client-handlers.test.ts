// Client-side handler contracts: capability advertisement is pure and omission-based; runtime
// validation catches JavaScript partial terminal objects before any ACP process can be spawned.
import test from "node:test";
import assert from "node:assert/strict";
import { AcpAgentRunner, clientCapabilitiesFor, type TerminalHandlers } from "../src/index.js";

const TERMINAL_HANDLERS: TerminalHandlers = {
  createTerminal: () => ({ terminalId: "term-1" }),
  terminalOutput: () => ({ output: "", truncated: false }),
  waitForTerminalExit: () => ({ exitCode: 0 }),
  killTerminal: () => undefined,
  releaseTerminal: () => undefined,
};

/** Advertised regardless of handlers: SessionHandle handles boolean config options natively. */
const BASE_CAPABILITIES = { session: { configOptions: { boolean: {} } } };

test("clientCapabilitiesFor: empty inputs advertise only the native session capabilities", () => {
  assert.deepEqual(clientCapabilitiesFor(undefined), BASE_CAPABILITIES);
  assert.deepEqual(clientCapabilitiesFor({}), BASE_CAPABILITIES);
  assert.deepEqual(clientCapabilitiesFor({ fs: {} }), BASE_CAPABILITIES);
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
