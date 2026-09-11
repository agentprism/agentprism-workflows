// Deterministic, credential-free host bridge for the complete production monitor. This module is
// imported only by preview.html, never by the shipped run-monitor entrypoint.
import type {
  App,
  McpUiHostCapabilities,
  McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { RunEventLogRecord } from "@automatalabs/shared-types";
import type { EventsDoc } from "./workflow-events-poll.js";
import type { RunStatusSnapshot } from "./run-status.js";
import { extractSkeleton } from "./skeleton.js";

export interface MockRun {
  snapshot: RunStatusSnapshot;
  events: RunEventLogRecord[];
  script: string;
  result: string;
  project: string;
}

export class MockRunStore {
  runs = new Map<string, MockRun>();
  notifications = new Map<string, { token: string; sent: boolean }>();
  create(runId: string, project = "project-one") {
    const run: MockRun = {
      snapshot: { runId, status: "running", pendingPermissions: [] },
      events: [],
      project,
      script:
        'export const meta = { name: "Monitor verification" }; phase("Research"); const report = await agent("Inspect transport", {label: "Research transport"}); await checkpoint("Publish findings?"); return report;',
      result: JSON.stringify({
        source: "authoritative result",
        findings: ["accepted"],
      }),
    };
    this.runs.set(runId, run);
    this.emit(runId, { type: "phase", title: "Research" });
    this.emit(runId, {
      type: "agentStart",
      label: "Research transport",
      prompt: "Inspect transport",
      callIndex: 0,
      model: "codex",
      path: [...(extractSkeleton(run.script)?.byKey.values() ?? [])].find(
        (site) => site.kind === "agent",
      )?.key,
    });
    for (let index = 0; index < 25; index++)
      this.emit(runId, {
        type: "agentTranscript",
        label: "Research transport",
        callIndex: 0,
        executionStartSeq: 2,
        entryIndex: index,
        revision: 1,
        operation: "upsert",
        entry: {
          kind: "text",
          text: `Observation ${index + 1}: checking the transport contract.`,
        },
      });
    return run;
  }
  emit(runId: string, event: Record<string, unknown>) {
    const run = this.runs.get(runId)!;
    run.events.push({
      version: 1,
      streamId: `stream-${runId}`,
      runId,
      seq: run.events.length + 1,
      timestamp: new Date(
        1_800_000_000_000 + run.events.length * 1000,
      ).toISOString(),
      event: { runId, scope: runId, ...event },
    } as unknown as RunEventLogRecord);
  }
  scenario(
    runId: string,
    name:
      | "running"
      | "setup"
      | "permission"
      | "checkpoint"
      | "completed"
      | "failed",
  ) {
    const run = this.runs.get(runId)!;
    run.snapshot = { runId, status: "running", pendingPermissions: [] };
    if (name === "setup") {
      run.snapshot.status = "pending";
      run.snapshot.setup = {
        state: "input-required",
        request: {
          id: `setup-${runId}`,
          kind: "backend-approval",
          title: "Approve backend",
          message: "Allow the configured backend to prepare this workflow.",
          requestedSchema: {
            type: "object",
            properties: {
              approve: { type: "boolean", title: "Approve backend" },
            },
            required: ["approve"],
            additionalProperties: false,
          },
        },
      };
    } else if (name === "permission") {
      run.snapshot.pendingPermissions = [
        {
          permissionId: `permission-${runId}`,
          runId,
          callIndex: 0,
          label: "Research transport",
          backendId: "codex",
          request: {
            toolCall: {
              title: "Read the transport specification",
              toolCallId: "read-spec",
            },
            options: [
              {
                optionId: "allow-once",
                name: "Allow once",
                kind: "allow_once",
              },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
        },
      ];
    } else if (name === "checkpoint") {
      run.snapshot.status = "paused";
      run.snapshot.pauseReason = "checkpoint_required";
      run.snapshot.checkpointContext = {
        callIndex: 1,
        hash: `checkpoint-${runId}`,
        kind: "confirm",
        prompt: "Publish findings?",
      };
      this.emit(runId, {
        type: "paused",
        reason: "checkpoint_required",
        checkpointContext: run.snapshot.checkpointContext,
      });
    } else if (name === "completed") {
      run.snapshot.status = "completed";
      this.emit(runId, {
        type: "agentEnd",
        label: "Research transport",
        callIndex: 0,
        result: {
          preview: "REDACTED PREVIEW — not exact output",
          redacted: true,
          truncated: true,
        },
      });
      this.emit(runId, {
        type: "complete",
        summary: { workflowName: "Monitor verification", agentCount: 1 },
      });
    } else if (name === "failed") {
      run.snapshot.status = "failed";
      this.emit(runId, {
        type: "error",
        errorRecord: { message: "The backend rejected execution." },
      });
    }
  }
}

export class MockHost extends EventTarget {
  ontoolinput: App["ontoolinput"];
  ontoolresult: App["ontoolresult"];
  ontoolcancelled: App["ontoolcancelled"];
  onhostcontextchanged: App["onhostcontextchanged"];
  onteardown: App["onteardown"];
  onerror: App["onerror"];
  calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  messages: Array<Parameters<App["sendMessage"]>[0]> = [];
  contexts: Array<Parameters<App["updateModelContext"]>[0]> = [];
  context: McpUiHostContext = {
    displayMode: "inline",
    availableDisplayModes: ["inline", "fullscreen"],
  };
  capabilities: McpUiHostCapabilities = {
    serverTools: {},
    serverResources: {},
    message: { text: {} },
    updateModelContext: { text: {} },
  };
  rejectMessage = false;
  rejectContext = false;
  rejectFullscreen = false;
  rejectAction = false;
  eventFailures = 0;
  statusDelayMs = 0;
  statusFailures = 0;
  deferEvents = false;
  deferred: Array<() => void> = [];
  closed = false;
  constructor(readonly store: MockRunStore, public runId = "run-a") {
    super();
  }
  asApp(): App {
    return this as unknown as App;
  }
  async connect() {
    this.input(this.runId);
  }
  async close() {
    this.closed = true;
  }
  getHostContext() {
    return this.context;
  }
  getHostCapabilities() {
    return this.capabilities;
  }
  input(runId: string) {
    this.runId = runId;
    this.ontoolinput?.({ arguments: { runId } });
  }
  invalidInput() {
    this.ontoolinput?.({ arguments: { action: "run", script: "return true" } });
  }
  result(runId: string, isError = false) {
    this.ontoolresult?.({
      structuredContent: { runId },
      content: [
        {
          type: "text",
          text: isError
            ? `No workflow run found for ${runId}`
            : "Monitor opened",
        },
      ],
      ...(isError ? { isError } : {}),
    });
  }
  hostContext(change: Partial<McpUiHostContext>) {
    this.context = { ...this.context, ...change };
    this.onhostcontextchanged?.(change);
  }
  cancel() {
    this.ontoolcancelled?.({ reason: "User cancelled opening" });
  }
  async teardown() {
    await this.onteardown?.({}, {} as never);
  }
  releaseEvents() {
    this.deferEvents = false;
    this.deferred.splice(0).forEach((release) => release());
  }
  async sendMessage(params: Parameters<App["sendMessage"]>[0]) {
    this.messages.push(params);
    return this.rejectMessage ? { isError: true } : {};
  }
  async updateModelContext(params: Parameters<App["updateModelContext"]>[0]) {
    if (this.rejectContext) throw new Error("Host rejected context");
    this.contexts.push(params);
    return {};
  }
  async requestDisplayMode({ mode }: Parameters<App["requestDisplayMode"]>[0]) {
    if (this.rejectFullscreen) throw new Error("Host rejected fullscreen");
    this.hostContext({ displayMode: mode });
    return { mode };
  }
  async readServerResource({ uri }: { uri: string }) {
    const runId = uri.split("/")[3]!;
    const run = this.store.runs.get(runId);
    if (!run) throw new Error("RUN_NOT_FOUND");
    return {
      contents: [{ uri, mimeType: "text/javascript", text: run.script }],
    };
  }
  async callServerTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<CallToolResult> {
    this.calls.push(structuredClone(params));
    const args = params.arguments ?? {};
    const runId = String(args.runId ?? "");
    const run = this.store.runs.get(runId);
    const ok = (
      structuredContent: Record<string, unknown>,
    ): CallToolResult => ({ structuredContent, content: [] });
    if (params.name === "workflow-runs") {
      const anchor = this.store.runs.get(String(args.anchorRunId));
      return ok({
        runs: [...this.store.runs]
          .filter(([, candidate]) => candidate.project === anchor?.project)
          .map(([id, candidate]) => ({
            runId: id,
            workflowName: `Workflow ${id}`,
            status: candidate.snapshot.status,
            startedAt: "",
            updatedAt: "",
          })),
      });
    }
    if (!run)
      throw new Error(`RUN_NOT_FOUND: No workflow run found for ${runId}`);
    if (params.name === "workflow-notifications") {
      const key = `${runId}:${String(args.eventId)}`;
      if (args.action === "claim") {
        if (this.store.notifications.has(key)) return ok({ send: false });
        const token = crypto.randomUUID();
        this.store.notifications.set(key, { token, sent: false });
        return ok({ send: true, token });
      }
      const claim = this.store.notifications.get(key);
      if (claim && claim.token === args.token) {
        if (args.action === "release") this.store.notifications.delete(key);
        else claim.sent = true;
      }
      return ok({ ok: true });
    }
    if (params.name === "workflow-events") {
      if (this.eventFailures > 0) {
        this.eventFailures--;
        throw new Error("Temporary connection failure");
      }
      const after = Number(args.after ?? 0);
      const events = structuredClone(
        run.events
          .filter((record) => record.seq > after)
          .slice(0, Number(args.limit ?? 500)),
      );
      const doc: EventsDoc = {
        schemaVersion: 1,
        runId,
        streamId: `stream-${runId}`,
        workflowName: `Workflow ${runId}`,
        status: run.snapshot.status,
        finalized:
          run.snapshot.status !== "pending" &&
          run.snapshot.status !== "running",
        after,
        cursor: events.at(-1)?.seq ?? after,
        endCursor: run.events.length,
        hasMore: after + events.length < run.events.length,
        events,
      };
      if (this.deferEvents)
        await new Promise<void>((resolve) => this.deferred.push(resolve));
      return ok(doc as unknown as Record<string, unknown>);
    }
    if (params.name !== "workflow")
      throw new Error(`Unsupported mock tool ${params.name}`);
    if (args.action === "status") {
      if (this.statusFailures > 0) {
        this.statusFailures--;
        throw new Error("Temporary status failure");
      }
      if (this.statusDelayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, this.statusDelayMs));
      const { pauseReason, checkpointContext, authContext, ...status } =
        structuredClone(run.snapshot);
      return ok({
        ...status,
        reason: pauseReason,
        outcome: { checkpointContext, authContext },
      });
    }
    if (this.rejectAction)
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "This request is stale. Refresh and use the current request.",
          },
        ],
      };
    if (args.action === "result") {
      if (run.snapshot.status !== "completed")
        throw new Error("Result is not complete");
      const offset = Number(args.offset ?? 0),
        endOffset = Math.min(
          run.result.length,
          offset + Number(args.maxBytes ?? 16384),
        );
      return ok({
        runId,
        action: "result",
        status: "completed",
        offset,
        endOffset,
        totalBytes: run.result.length,
        hasMore: endOffset < run.result.length,
        chunk: run.result.slice(offset, endOffset),
      });
    }
    if (args.action === "stop") {
      if (args.callIndex !== undefined)
        this.store.emit(runId, {
          type: "agentError",
          callIndex: args.callIndex,
          errorRecord: { message: "Agent stopped" },
        });
      else {
        run.snapshot.status = "aborted";
        this.store.emit(runId, { type: "stopped" });
      }
    } else if (args.action === "permissions-response") {
      if (
        !run.snapshot.pendingPermissions?.some(
          (request) => request.permissionId === args.permissionId,
        )
      )
        throw new Error("Permission is stale");
      run.snapshot.pendingPermissions = [];
    } else if (args.action === "setup-response") {
      if (run.snapshot.setup?.request?.id !== args.setupId)
        throw new Error("Setup request is stale");
      const response = args.response as { action: string };
      run.snapshot = {
        runId,
        status: response.action === "accept" ? "running" : "aborted",
      };
      if (response.action !== "accept")
        this.store.emit(runId, { type: "stopped" });
    } else if (args.action === "resume") {
      run.snapshot = { runId, status: "running" };
      this.store.emit(runId, { type: "resumed" });
    } else throw new Error(`Unsupported mock action ${String(args.action)}`);
    return ok({ runId, accepted: true });
  }
}
