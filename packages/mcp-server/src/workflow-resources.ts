import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ResourceLink } from "@modelcontextprotocol/sdk/types.js";
import type { PersistedRunState, WorkflowManager } from "@automatalabs/workflows";

import type {
  WorkflowScriptLineageEntry,
  WorkflowScriptSource,
} from "./workflow-tool-output.js";

export const SCRIPT_RESOURCE_MIME_TYPE = "text/javascript";
export const SCRIPT_RESOURCE_LIST_LIMIT = 50;

const SCRIPT_URI_PATTERN = /^workflow:\/\/runs\/([a-z0-9]+-[a-z0-9]+)\/script$/;

interface PersistedMcpRunMetadata {
  scriptSource?: WorkflowScriptSource;
  resumeSeed?: { sourceRunId: string; ancestorRunIds?: string[] };
}

type PersistedMcpRunState = PersistedRunState & PersistedMcpRunMetadata;

interface StoredRunMetadata {
  scriptSource: WorkflowScriptSource;
  resumeSourceRunId?: string;
  ancestorRunIds?: string[];
  elicitationController?: AbortController;
}

interface AdmissionMetadata extends StoredRunMetadata {
  script: string;
}

export interface WorkflowAdmission extends AdmissionMetadata {
  runId?: string;
}

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

/**
 * Persistence-backed MCP script resources plus the small amount of per-process state required
 * for subscriptions and cancellable checkpoint elicitation. Script content is always loaded from
 * RunPersistence; no in-memory content registry exists.
 */
export class WorkflowScriptResources {
  private readonly persistence: ReturnType<WorkflowManager["getPersistence"]>;
  private readonly subscriptions = new Set<string>();
  private readonly pendingAdmissions: WorkflowAdmission[] = [];
  private readonly metadataByRunId = new Map<string, StoredRunMetadata>();

  constructor(
    private readonly mcp: McpServer,
    manager: WorkflowManager,
  ) {
    this.persistence = manager.getPersistence();
    this.instrumentPersistence();
    this.registerProtocolSurface();
  }

  beginAdmission(metadata: AdmissionMetadata): WorkflowAdmission {
    const admission: WorkflowAdmission = { ...metadata };
    this.pendingAdmissions.push(admission);
    return admission;
  }

  finishAdmission(admission: WorkflowAdmission): void {
    const pendingIndex = this.pendingAdmissions.indexOf(admission);
    if (pendingIndex >= 0) this.pendingAdmissions.splice(pendingIndex, 1);
    if (admission.runId) {
      const metadata = this.metadataByRunId.get(admission.runId);
      if (metadata) metadata.elicitationController = undefined;
    }
  }

  cancelPendingElicitation(runId: string): void {
    this.metadataByRunId.get(runId)?.elicitationController?.abort();
  }

  scriptSource(runId: string): WorkflowScriptSource | undefined {
    return (this.persistence.load(runId) as PersistedMcpRunState | null)?.scriptSource;
  }

  lineage(runId: string): WorkflowScriptLineageEntry[] {
    const newestToOldest: WorkflowScriptLineageEntry[] = [];
    const visited = new Set<string>();
    let currentRunId: string | undefined = runId;

    while (currentRunId && !visited.has(currentRunId)) {
      visited.add(currentRunId);
      const state = this.persistence.load(currentRunId) as PersistedMcpRunState | null;
      if (state?.resumeSeed?.ancestorRunIds) {
        return [...state.resumeSeed.ancestorRunIds, currentRunId].map((lineageRunId) => ({
          runId: lineageRunId,
          uri: workflowScriptUri(lineageRunId),
          available: this.persistence.load(lineageRunId) !== null,
        }));
      }
      newestToOldest.push({
        runId: currentRunId,
        uri: workflowScriptUri(currentRunId),
        available: state !== null,
      });
      if (!state) break;
      currentRunId = state.resumeSeed?.sourceRunId;
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

  private instrumentPersistence(): void {
    const save = this.persistence.save.bind(this.persistence);
    this.persistence.save = (state) => {
      let metadata = this.metadataByRunId.get(state.runId);
      let newlyAdmitted = false;
      if (!metadata) {
        const embedded = state as PersistedMcpRunState;
        if (embedded.scriptSource || embedded.resumeSeed) {
          metadata = {
            scriptSource: embedded.scriptSource ?? "inline",
            resumeSourceRunId: embedded.resumeSeed?.sourceRunId,
            ancestorRunIds: embedded.resumeSeed?.ancestorRunIds,
          };
          this.metadataByRunId.set(state.runId, metadata);
        } else {
          const admissionIndex = this.pendingAdmissions.findIndex((candidate) => candidate.script === state.script);
          if (admissionIndex >= 0) {
            const admission = this.pendingAdmissions.splice(admissionIndex, 1)[0];
            admission.runId = state.runId;
            metadata = {
              scriptSource: admission.scriptSource,
              resumeSourceRunId: admission.resumeSourceRunId,
              ancestorRunIds: admission.ancestorRunIds,
              elicitationController: admission.elicitationController,
            };
            if (metadata.resumeSourceRunId && !metadata.ancestorRunIds) {
              metadata.ancestorRunIds = this.lineage(metadata.resumeSourceRunId).map((entry) => entry.runId);
            }
            this.metadataByRunId.set(state.runId, metadata);
            newlyAdmitted = true;
          }
        }
      }

      const persisted: PersistedMcpRunState = metadata
        ? {
            ...state,
            scriptSource: metadata.scriptSource,
            ...(metadata.resumeSourceRunId
              ? {
                  resumeSeed: {
                    sourceRunId: metadata.resumeSourceRunId,
                    ancestorRunIds: metadata.ancestorRunIds ?? [metadata.resumeSourceRunId],
                  },
                }
              : {}),
          }
        : state;
      save(persisted);
      if (newlyAdmitted) this.mcp.sendResourceListChanged();
    };

    const remove = this.persistence.delete.bind(this.persistence);
    this.persistence.delete = (runId) => {
      const deleted = remove(runId);
      if (deleted) {
        const uri = workflowScriptUri(runId);
        this.subscriptions.delete(uri);
        this.metadataByRunId.delete(runId);
        this.mcp.sendResourceListChanged();
      }
      return deleted;
    };
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
      this.subscriptions.delete(request.params.uri);
      return {};
    });
  }
}
