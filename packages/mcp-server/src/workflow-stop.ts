import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { WorkflowManager } from "@automatalabs/workflows";

/**
 * A stop response is final only when both the aborted snapshot and the matching stopped event
 * are durably readable. Used by local MCP stops, predecessor control RPC, and cold-stop recovery.
 */
export function requireDurableStoppedRun(manager: WorkflowManager, runId: string): void {
  const persistence = manager.getPersistence();
  const persisted = persistence.load(runId);
  if (persisted?.status !== "aborted") {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `Workflow stop for runId "${runId}" could not be durably acknowledged: the persisted status is ${persisted?.status ?? "missing"}, not aborted.`,
    );
  }
  if (
    persisted.eventLogIncomplete ||
    persisted.eventStreamId === undefined ||
    persisted.eventSeq === undefined ||
    persisted.eventSeq < 1
  ) {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `Workflow stop for runId "${runId}" could not be durably acknowledged: its stopped event is not durably readable.`,
    );
  }

  let stoppedEventIsDurable = false;
  try {
    const events = persistence.readEvents(runId, {
      after: persisted.eventSeq - 1,
      streamId: persisted.eventStreamId,
      limit: 1,
    });
    stoppedEventIsDurable = events.events.some(
      (record) => record.seq === persisted.eventSeq && record.event.type === "stopped",
    );
  } catch {
    stoppedEventIsDurable = false;
  }
  if (!stoppedEventIsDurable) {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `Workflow stop for runId "${runId}" could not be durably acknowledged: its terminal stopped event is missing.`,
    );
  }
}
