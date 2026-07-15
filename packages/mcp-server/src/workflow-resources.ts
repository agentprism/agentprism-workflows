import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ResourceLink } from "@modelcontextprotocol/sdk/types.js";
import type { PersistedRunState, WorkflowManager } from "@automatalabs/workflows";
import { AsyncLocalStorage } from "node:async_hooks";

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
  resourceAvailable?: boolean;
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
  private readonly admissionContext = new AsyncLocalStorage<WorkflowAdmission>();
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
    return { ...metadata };
  }

  runAdmission<T>(admission: WorkflowAdmission, operation: () => T): T {
    return this.admissionContext.run(admission, operation);
  }

  finishAdmission(admission: WorkflowAdmission): void {
    if (admission.runId) {
      const metadata = this.metadataByRunId.get(admission.runId);
      if (metadata) metadata.elicitationController = undefined;
    }
  }

  admissionResourceAvailable(admission: WorkflowAdmission): boolean {
    if (!admission.resourceAvailable || !admission.runId) return false;
    try {
      return this.persistence.load(admission.runId) !== null;
    } catch {
      return false;
    }
  }

  cancelPendingElicitation(runId: string): void {
    this.metadataByRunId.get(runId)?.elicitationController?.abort();
  }

  scriptSource(runId: string): WorkflowScriptSource | undefined {
    const state = this.persistence.load(runId) as PersistedMcpRunState | null;
    return state ? state.scriptSource ?? "inline" : undefined;
  }

  lineage(runId: string): WorkflowScriptLineageEntry[] {
    const newestToOldest: string[] = [];
    const pointerVisited = new Set<string>();
    let currentRunId: string | undefined = runId;

    while (currentRunId && !pointerVisited.has(currentRunId)) {
      pointerVisited.add(currentRunId);
      const state = this.persistence.load(currentRunId) as PersistedMcpRunState | null;
      if (state?.resumeSeed?.ancestorRunIds) {
        const oldestToNewest = [
          ...state.resumeSeed.ancestorRunIds,
          state.resumeSeed.sourceRunId,
          currentRunId,
        ];
        return this.projectLineage(oldestToNewest, runId);
      }
      newestToOldest.push(currentRunId);
      if (!state) break;
      currentRunId = state.resumeSeed?.sourceRunId;
    }

    return this.projectLineage(newestToOldest.reverse(), runId);
  }

  private projectLineage(oldestToNewest: string[], requestedRunId: string): WorkflowScriptLineageEntry[] {
    const visited = new Set<string>();
    const normalized: string[] = [];
    for (const lineageRunId of oldestToNewest) {
      if (lineageRunId === requestedRunId || visited.has(lineageRunId)) continue;
      visited.add(lineageRunId);
      normalized.push(lineageRunId);
    }
    normalized.push(requestedRunId);
    return normalized.map((lineageRunId) => ({
      runId: lineageRunId,
      uri: workflowScriptUri(lineageRunId),
      available: this.persistence.load(lineageRunId) !== null,
    }));
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
      const committedMetadata = this.metadataByRunId.get(state.runId);
      const embedded = state as PersistedMcpRunState;
      const embeddedMetadata: StoredRunMetadata | undefined =
        embedded.scriptSource || embedded.resumeSeed
          ? {
              scriptSource: embedded.scriptSource ?? "inline",
              resumeSourceRunId: embedded.resumeSeed?.sourceRunId,
              ancestorRunIds: embedded.resumeSeed?.ancestorRunIds,
            }
          : undefined;
      const admission = this.admissionContext.getStore();
      const matchingAdmission =
        admission && (admission.runId === undefined || admission.runId === state.runId)
          ? admission
          : undefined;
      if (matchingAdmission && matchingAdmission.runId === undefined) matchingAdmission.runId = state.runId;

      const admissionMetadata: StoredRunMetadata | undefined = matchingAdmission
        ? {
            scriptSource: matchingAdmission.scriptSource,
            resumeSourceRunId: matchingAdmission.resumeSourceRunId,
            ancestorRunIds: matchingAdmission.ancestorRunIds,
            elicitationController: matchingAdmission.elicitationController,
          }
        : undefined;
      if (admissionMetadata?.resumeSourceRunId && !admissionMetadata.ancestorRunIds) {
        admissionMetadata.ancestorRunIds = this.lineage(admissionMetadata.resumeSourceRunId).map(
          (entry) => entry.runId,
        );
      }
      const metadata = committedMetadata ?? embeddedMetadata ?? admissionMetadata;
      const newlyAdmitted =
        committedMetadata === undefined && embeddedMetadata === undefined && matchingAdmission !== undefined;

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
      if (metadata && committedMetadata === undefined) this.metadataByRunId.set(state.runId, metadata);
      if (newlyAdmitted && matchingAdmission) {
        matchingAdmission.resourceAvailable = true;
        void this.mcp.sendResourceListChanged();
      }
    };

    const remove = this.persistence.delete.bind(this.persistence);
    this.persistence.delete = (runId) => {
      const deleted = remove(runId);
      if (deleted) {
        const uri = workflowScriptUri(runId);
        this.subscriptions.delete(uri);
        this.metadataByRunId.delete(runId);
        void this.mcp.sendResourceListChanged();
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
