import { methods, type AgentContext } from "@agentclientprotocol/sdk";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { mapKind } from "./translate.js";

interface PermissionHost {
  readonly sessionId: string;
  readonly client: AgentContext;
  drain(): Promise<void>;
  turnSignal(): AbortSignal | undefined;
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  promise.then(() => undefined, () => undefined);
  if (signal.aborted) return Promise.resolve(undefined);
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      signal.addEventListener("abort", () => resolve(undefined), { once: true });
    }),
  ]);
}

export function installPermissionWrapper(session: AgentSession, host: PermissionHost): void {
  const inner = session.agent.beforeToolCall;
  const alwaysAllowed = new Set<string>();
  session.agent.beforeToolCall = async (context, signal) => {
    const toolName = context.toolCall.name;
    let block = false;
    let reason: string | undefined;
    if (!alwaysAllowed.has(toolName)) {
      await host.drain();
      const turnSignal = host.turnSignal() ?? signal ?? new AbortController().signal;
      try {
        const pending = host.client.request(
          methods.client.session.requestPermission,
          {
            sessionId: host.sessionId,
            toolCall: {
              toolCallId: context.toolCall.id,
              title: toolName,
              kind: mapKind(toolName),
              _meta: { toolName },
            },
            options: [
              { optionId: "allow_always", name: `Always allow ${toolName}`, kind: "allow_always" },
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject_once", name: "Reject", kind: "reject_once" },
            ],
          },
          { cancellationSignal: turnSignal },
        );
        const response = await raceSignal(pending, turnSignal);
        if (response === undefined) {
          block = true;
          reason = "cancelled";
        } else if (typeof response.outcome !== "object" || response.outcome === null || !("outcome" in response.outcome)) {
          block = true;
          reason = "unrecognized permission selection";
        } else if (response.outcome.outcome === "cancelled") {
          block = true;
          reason = "cancelled";
        } else if (response.outcome.optionId === "allow_once") {
          block = false;
        } else if (response.outcome.optionId === "allow_always") {
          alwaysAllowed.add(toolName);
          block = false;
        } else if (response.outcome.optionId === "reject_once") {
          block = true;
          reason = "denied by user";
        } else {
          block = true;
          reason = "unrecognized permission selection";
        }
      } catch {
        block = true;
        reason = "permission unavailable";
      }
    }
    if (block) return { block: true, reason };
    return inner ? inner(context, signal) : undefined;
  };
}
