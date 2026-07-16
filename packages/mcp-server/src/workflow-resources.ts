import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ResourceLink } from "@modelcontextprotocol/sdk/types.js";
import type { PersistedRunState, WorkflowManager } from "@automatalabs/workflows";

import type { WorkflowScriptLineageEntry } from "./workflow-tool-output.js";

export const SCRIPT_RESOURCE_MIME_TYPE = "text/javascript";
export const SCRIPT_RESOURCE_LIST_LIMIT = 50;

const SCRIPT_URI_PATTERN = /^workflow:\/\/runs\/([a-z0-9]+-[a-z0-9]+)\/script$/;

function resourceNotFound(uri: string): never {
  throw new McpError(ErrorCode.InvalidParams, `Workflow script resource not found: ${uri}`);
}

export function workflowScriptUri(runId: string): string {
  return `workflow://runs/${runId}/script`;
}

export function workflowRunIdFromScriptUri(uri: string): string | undefined {
  return SCRIPT_URI_PATTERN.exec(uri)?.[1];
}

function startedAtMillis(state: PersistedRunState): number {
  const parsed = Date.parse(state.startedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function lineageSourceRunId(state: PersistedRunState): string | undefined {
  const reportSource = state.resumeReport?.sourceRunId;
  if (reportSource) return reportSource;
  const seedSource = state.resumeSeed?.sourceRunId;
  return seedSource === state.runId ? undefined : seedSource;
}

function lineageFallbackRunIds(state: PersistedRunState): string[] {
  const runIds = [
    ...(state.resumeSeed?.candidates.map((candidate) => candidate.sourceRunId) ?? []),
    ...(state.resumeSeed?.checkpointInjections?.map((injection) => injection.sourceRunId) ?? []),
    ...(state.resumeReport?.calls.flatMap((decision) =>
      decision.action === "replayed" ? [decision.sourceRunId] : []) ?? []),
  ];
  return [...new Set(runIds)];
}

/**
 * Persistence-backed MCP script resources. Run content and lineage are read directly from the
 * engine store for every request; the only process-local state is protocol bookkeeping and a
 * transient controller for a live foreground checkpoint elicitation.
 */
export class WorkflowScriptResources {
  private readonly persistence: ReturnType<WorkflowManager["getPersistence"]>;
  private readonly subscriptions = new Set<string>();
  private readonly deletedRunIds = new Set<string>();
  private readonly elicitationControllers = new Map<string, AbortController>();

  constructor(
    private readonly mcp: McpServer,
    private readonly manager: WorkflowManager,
  ) {
    this.persistence = manager.getPersistence();
    this.registerProtocolSurface();
  }

  /** Announce a resource only after the server has read its admitted record back successfully. */
  notifyRunAdmitted(runId: string): void {
    this.deletedRunIds.delete(runId);
    void this.mcp.sendResourceListChanged();
  }

  /** Bind the only request-lifetime admission state after the manager reveals the run ID. */
  trackPendingElicitation(runId: string, controller: AbortController | undefined): void {
    if (controller) this.elicitationControllers.set(runId, controller);
  }

  clearPendingElicitation(runId: string): void {
    this.elicitationControllers.delete(runId);
  }

  cancelPendingElicitation(runId: string): void {
    this.elicitationControllers.get(runId)?.abort();
    this.elicitationControllers.delete(runId);
  }

  /**
   * Delete through the composition boundary so subscription state and list notifications stay in
   * sync. Failed-admission cleanup passes notify=false because that resource was never announced.
   */
  deleteRun(runId: string, notify = true): boolean {
    const deleted = this.manager.deleteRun(runId);
    if (!deleted) return false;
    const uri = workflowScriptUri(runId);
    this.subscriptions.delete(uri);
    this.elicitationControllers.delete(runId);
    this.deletedRunIds.add(runId);
    if (notify) void this.mcp.sendResourceListChanged();
    return true;
  }

  /** Pure projection over the engine-owned durable resume source pointers. */
  lineage(runId: string): WorkflowScriptLineageEntry[] {
    const newestToOldest: WorkflowScriptLineageEntry[] = [];
    const visited = new Set<string>();
    const fallbackRunIds: string[] = [];
    let currentRunId: string | undefined = runId;

    while (currentRunId && !visited.has(currentRunId)) {
      visited.add(currentRunId);
      const state = this.persistence.load(currentRunId);
      newestToOldest.push({
        runId: currentRunId,
        uri: workflowScriptUri(currentRunId),
        available: state !== null,
      });
      if (!state) {
        currentRunId = fallbackRunIds.find((candidate) => !visited.has(candidate));
        continue;
      }
      for (const fallbackRunId of lineageFallbackRunIds(state)) {
        if (!visited.has(fallbackRunId) && !fallbackRunIds.includes(fallbackRunId)) {
          fallbackRunIds.push(fallbackRunId);
        }
      }
      currentRunId = lineageSourceRunId(state);
    }

    return newestToOldest.reverse();
  }

  links(lineage: WorkflowScriptLineageEntry[]): ResourceLink[] {
    const links: ResourceLink[] = [];
    for (const entry of lineage) {
      if (!entry.available) continue;
      const state = this.persistence.load(entry.runId);
      if (!state) continue;
      links.push({
        type: "resource_link",
        uri: entry.uri,
        name: `${state.workflowName} (${state.runId})`,
        description: `${state.status} · started ${state.startedAt}`,
        mimeType: SCRIPT_RESOURCE_MIME_TYPE,
      });
    }
    return links;
  }

  private recentRuns(): PersistedRunState[] {
    return this.persistence
      .list()
      .sort((left, right) => startedAtMillis(right) - startedAtMillis(left) || right.runId.localeCompare(left.runId))
      .slice(0, SCRIPT_RESOURCE_LIST_LIMIT);
  }

  private registerProtocolSurface(): void {
    this.mcp.registerResource(
      "workflow-run-script",
      new ResourceTemplate("workflow://runs/{runId}/script", {
        list: () => ({
          resources: this.recentRuns().map((state) => ({
            uri: workflowScriptUri(state.runId),
            name: `${state.workflowName} (${state.runId})`,
            description: `${state.status} · started ${state.startedAt}`,
            mimeType: SCRIPT_RESOURCE_MIME_TYPE,
          })),
        }),
        complete: {
          runId: (partial) =>
            this.recentRuns()
              .map((state) => state.runId)
              .filter((runId) => runId.startsWith(partial)),
        },
      }),
      {
        title: "Workflow run scripts",
        description:
          "Immutable admitted workflow scripts. Listing is discovery-only and contains at most the 50 newest runs by startedAt; direct workflow://runs/{runId}/script reads are unbounded.",
        mimeType: SCRIPT_RESOURCE_MIME_TYPE,
      },
      (uri) => {
        const runId = workflowRunIdFromScriptUri(uri.toString());
        if (!runId) resourceNotFound(uri.toString());
        const state = this.persistence.load(runId);
        if (!state) resourceNotFound(uri.toString());
        return {
          contents: [
            {
              uri: workflowScriptUri(runId),
              mimeType: SCRIPT_RESOURCE_MIME_TYPE,
              text: state.script,
            },
          ],
        };
      },
    );

    this.mcp.server.setRequestHandler(SubscribeRequestSchema, (request) => {
      const uri = request.params.uri;
      const runId = workflowRunIdFromScriptUri(uri);
      if (!runId || !this.persistence.load(runId)) resourceNotFound(uri);
      this.subscriptions.add(uri);
      return {};
    });
    this.mcp.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
      const uri = request.params.uri;
      const runId = workflowRunIdFromScriptUri(uri);
      if (!runId) resourceNotFound(uri);
      if (
        !this.persistence.load(runId) &&
        !this.deletedRunIds.has(runId) &&
        !this.subscriptions.has(uri)
      ) {
        resourceNotFound(uri);
      }
      this.subscriptions.delete(uri);
      return {};
    });
  }
}
