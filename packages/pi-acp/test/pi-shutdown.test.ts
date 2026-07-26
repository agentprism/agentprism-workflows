import test from "node:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { emitPiSessionShutdown, shutdownPiSession } from "../src/pi-shutdown.js";

// Pi tears a session down in two steps (AgentSessionRuntime.dispose): emit `session_shutdown` so
// extensions release what they own, THEN AgentSession.dispose(). pi-acp used to call only the
// second, so an extension that had spawned a process never got its cleanup hook and the child
// outlived the session. Embedded in-process, that unreaped grandchild holds a ChildProcess handle
// on OUR event loop and the process can never exit — which is what wedged every pi-acp suite that
// opened a session on a machine with real pi extensions configured.

type Emitted = { type: string; reason?: string };

function fakeSession(options: { handlers?: boolean; emit?: () => Promise<unknown> } = {}) {
  const order: string[] = [];
  const emitted: Emitted[] = [];
  const session = {
    extensionRunner: {
      hasHandlers: (eventType: string) => {
        assert.equal(eventType, "session_shutdown");
        return options.handlers ?? true;
      },
      emit: async (event: Emitted) => {
        order.push(`emit:${event.type}`);
        emitted.push(event);
        if (options.emit) return options.emit();
        return undefined;
      },
    },
    dispose: () => { order.push("dispose"); },
  } as unknown as AgentSession;
  return { session, order, emitted };
}

test("session_shutdown reaches extensions before the session is disposed", async () => {
  const { session, order, emitted } = fakeSession();
  await shutdownPiSession(session);
  // Order is the whole point: dispose() marks the extension context stale, so an event emitted
  // after it would reach handlers that can no longer act.
  assert.deepEqual(order, ["emit:session_shutdown", "dispose"]);
  assert.deepEqual(emitted, [{ type: "session_shutdown", reason: "quit" }]);
});

test("reason is 'quit' — the terminal reason, not a session-replacement one", async () => {
  const { session, emitted } = fakeSession();
  await emitPiSessionShutdown(session);
  // "reload"/"new"/"resume"/"fork" tell an extension the session is being REPLACED and it should
  // hand resources to the successor. pi-acp is closing for good; extensions must fully release.
  assert.equal(emitted[0]?.reason, "quit");
});

test("no registered handlers means no emit and no error", async () => {
  const { session, order } = fakeSession({ handlers: false });
  assert.equal(await emitPiSessionShutdown(session), false);
  assert.deepEqual(order, []);
});

// The disposal path must be unstrandable: a broken extension cannot be allowed to prevent
// dispose() from running, or one bad handler leaks the whole session's resources.
test("a throwing extension handler still lets disposal proceed", async () => {
  const { session, order } = fakeSession({ emit: () => Promise.reject(new Error("bad extension")) });
  await assert.doesNotReject(shutdownPiSession(session));
  assert.deepEqual(order, ["emit:session_shutdown", "dispose"]);
});

// `agentDir` is OPTIONAL on PiAcpDeps so the frozen `new PiAcpAgent(deps)` contract stays source
// compatible — which means a suite could omit it and silently fall back to the developer's real
// ~/.pi, reloading their extensions and re-wedging the runner at exit. The shared harness must
// always pin an isolated one; this guard is what makes the optionality safe.
test("the fake deps harness always supplies an isolated agentDir", async () => {
  const { fakeDeps } = await import("./helpers/fakes.js");
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const { deps, agentDir } = fakeDeps();
  assert.equal(typeof deps.agentDir, "string");
  assert.equal(deps.agentDir, agentDir);
  assert.notEqual(deps.agentDir, getAgentDir(), "the suite must never load the developer's pi config");
});

test("a session with no extension runtime at all is handled", async () => {
  const session = { dispose: () => {} } as unknown as AgentSession;
  assert.equal(await emitPiSessionShutdown(session), false);
  await assert.doesNotReject(shutdownPiSession(session));
});

// The failed-open branch: pi exists but the session never became publishable, so
// FailedOpenCleanup — not PiSession — owns teardown. It routes through the same helper, but
// "routes through the same helper" stays an assumption until the branch is actually driven.
test("failed-open cleanup also emits session_shutdown", async () => {
  const { fakeDeps, context } = await import("./helpers/fakes.js");
  const { PiAcpAgent } = await import("../src/agent.js");
  const setup = fakeDeps();
  const emitted: Array<{ type: string; reason?: string }> = [];
  const inner = setup.deps.createAgentSession;
  setup.deps.createAgentSession = async (options) => {
    const created = await inner(options);
    const session = created.session as unknown as Record<string, unknown>;
    session["extensionRunner"] = {
      hasHandlers: () => true,
      emit: async (event: { type: string; reason?: string }) => { emitted.push(event); },
    };
    // Throwing here strands the open after pi exists — exactly the failed-open shape.
    session["bindExtensions"] = async () => { throw new Error("bindExtensions failed"); };
    return created;
  };
  const agent = new PiAcpAgent(setup.deps);
  await assert.rejects(agent.newSession(context({ cwd: setup.cwd, mcpServers: [] })));
  assert.deepEqual(
    emitted,
    [{ type: "session_shutdown", reason: "quit" }],
    "a session that failed open still owns whatever its extensions started",
  );
  await agent.dispose().catch(() => undefined);
});
