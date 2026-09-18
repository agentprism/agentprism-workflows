// The runner-side AgentSessionRef builder, extracted from runner.ts as a pure move so the
// SDK-style AcpAgent (src/agent/) reports the same ref shape the runner's onSessionOpen does.
// Module export only — deliberately NOT re-exported from the package barrel.
import type { AgentSessionRef } from "@automatalabs/shared-types";
import type { SessionHandle } from "./acp-client.js";
import type { Backend } from "./backend.js";
import { costGaugeInheritance } from "./protocol-coverage.js";
import type { BackendRegistry } from "./registry.js";

/** A verbatim model id as the routing spec that leads back to `backendId` — the form
 *  `AgentSessionRef.model` and `AcpAgent.model` share. */
export function routedModelSpec(backendId: string, modelSpec: string): string {
  return `${backendId}/${modelSpec}`;
}

/** The re-attach handle for an open session: id + backend routing name + cwd + the
 *  agent-advertised reopen surface + the model selected on it. Contains no secrets;
 *  JSON-round-trippable. `model ?? backendId` is the `model` routing spec for
 *  loadSession/resumeSession; `backendId` alone routes listSessions. */
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
    ...(session.selectedModel !== undefined ? { model: routedModelSpec(backend.id, session.selectedModel) } : {}),
    ...(session.usage.costGauge !== undefined ? { costGauge: session.usage.costGauge } : {}),
  };
}

/** A recorded `AgentSessionRef.costGauge` as a usable figure; a malformed one is no seed at all. */
export function validCostGauge(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The seed for `UsageAccumulator.settleInheritedCost` when `backend` reopens (`reopen`) or forks
 *  (`fork`) a session whose cumulative cost gauge last read `sourceGauge`: the gauge itself where
 *  the agent carries it over, `undefined` where the agent restarts it (`COST_GAUGE_INHERITANCE`). */
export function inheritedCostSeed(
  backend: Backend,
  registry: BackendRegistry,
  kind: "reopen" | "fork",
  sourceGauge: number | undefined,
): number | undefined {
  const row = costGaugeInheritance(backend.id, registry.get(backend.id) !== undefined);
  return row[kind] === "inherits" ? sourceGauge : undefined;
}
