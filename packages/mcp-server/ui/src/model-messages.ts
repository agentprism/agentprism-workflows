// Selective ui/message notifications emitted while event pages fold. The panel informs the
// model only about workflow-owned phase boundaries, pauses that need attention, and terminal
// outcomes. Rendering and polling never depend on delivery.
import type { App } from "@modelcontextprotocol/ext-apps";
import type { PersistedRunEvent, RunEventLogRecord } from "@automatalabs/shared-types";

import { pausedBanner } from "./state.js";

export interface ModelMessageState {
  /** False until the first successful page whose cursor starts at zero has folded. */
  bootstrapped: boolean;
  /** Highest event sequence observed, retained across stream-model rebuilds for panel lifetime. */
  highWaterSeq: number;
}

export function createModelMessageState(): ModelMessageState {
  return { bootstrapped: false, highWaterSeq: 0 };
}

export function modelMessageText(runId: string, event: PersistedRunEvent): string | undefined {
  switch (event.type) {
    case "phase":
      return `[workflow run ${runId}] Phase started: "${event.title}".`;
    case "paused":
      return `[workflow run ${runId}] ${pausedBanner(event)}`;
    case "complete":
      return `[workflow run ${runId}] Run completed.`;
    case "error": {
      const message = event.errorRecord.message;
      return `[workflow run ${runId}] Run failed${message ? `: ${message}` : ""}.`;
    }
    case "stopped":
      return `[workflow run ${runId}] Run stopped.`;
    default:
      return undefined;
  }
}

type MessageApp = Pick<App, "sendMessage">;

function sendOnce(app: MessageApp, text: string): void {
  try {
    void app
      .sendMessage({ role: "user", content: [{ type: "text", text }] })
      .then((result) => {
        if (result.isError === true) console.error("Workflow run model message was rejected.");
      })
      .catch((error: unknown) => {
        console.error("Workflow run model message failed.", error);
      });
  } catch (error) {
    console.error("Workflow run model message failed.", error);
  }
}

/**
 * Observe one successfully folded page. The cursor-zero bootstrap is deliberately silent even
 * when it contains the run's full history. Later pages attempt one message per selected event;
 * sequence high-water dedupe survives stream rebuilds and rejected deliveries are never retried.
 */
export function sendModelMessagesForFold(
  app: MessageApp,
  runId: string,
  pageAfter: number,
  records: readonly RunEventLogRecord[],
  state: ModelMessageState,
): void {
  if (!state.bootstrapped && pageAfter === 0) {
    state.bootstrapped = true;
    for (const record of records) state.highWaterSeq = Math.max(state.highWaterSeq, record.seq);
    return;
  }
  if (!state.bootstrapped) return;

  for (const record of records) {
    if (record.seq <= state.highWaterSeq) continue;
    state.highWaterSeq = record.seq;
    const text = modelMessageText(runId, record.event);
    if (text !== undefined) sendOnce(app, text);
  }
}
