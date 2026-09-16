// The runner-side AgentSessionRef builder, extracted from runner.ts as a pure move so the
// SDK-style AcpAgent (src/agent/) reports the same ref shape the runner's onSessionOpen does.
// Module export only — deliberately NOT re-exported from the package barrel.
import type { AgentSessionRef } from "@automatalabs/shared-types";
import type { SessionHandle } from "./acp-client.js";
import type { Backend } from "./backend.js";

/** The re-attach handle for an open session: id + backend routing name + cwd + the
 *  agent-advertised reopen surface. Contains no secrets; JSON-round-trippable. `backendId`
 *  doubles as the `model` routing spec for loadSession/resumeSession/listSessions. */
export function sessionRefFor(session: SessionHandle, backend: Backend, cwd: string): AgentSessionRef {
  const caps = session.capabilities;
  return {
    sessionId: session.sessionId,
    backendId: backend.id,
    poolKey: backend.poolKey ?? backend.id,
    ...(session.initializeMeta !== undefined
      ? { initializeMeta: session.initializeMeta }
      : {}),
    cwd,
    reopen: {
      load: caps?.supportsLoadSession === true,
      resume: caps?.supportsResumeSession === true,
      list: caps?.supportsListSessions === true,
      fork: caps?.supportsForkSession === true,
    },
  };
}
