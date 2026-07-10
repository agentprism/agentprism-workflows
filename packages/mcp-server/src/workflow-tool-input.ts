// packages/mcp-server/src/workflow-tool-input.ts
//
// Input schema for the MCP `workflow` tool (registerTool inputSchema). The MCP TS SDK
// validates a Zod RAW SHAPE (ZodRawShapeCompat, verified mcp.d.ts:150-154) and rejects
// with InvalidParams BEFORE the handler runs — so numeric BOUNDS are deliberately PLAIN
// numbers, never z.number().max(...): out-of-range values must be CLAMPED by the engine
// (normalizeConcurrency -> MAX_CONCURRENCY 16; normalizeAgentRetries -> MAX_AGENT_RETRIES 3),
// NOT rejected. This is a behavioral contract (ground-truth corrections item 3, README §4):
// keep ONLY type + positivity in Zod; never add .max(). These mirror WorkflowManager.runSync
// ExecOptions { resumeJournal, checkpointReplies, maxAgents, tokenBudget, concurrency,
// agentRetries, confirm, onProgress }.
//
// One semantic change vs Pi: the run is SYNCHRONOUS (one tools/call == one full run, awaited
// to completion; taskSupport:'forbidden'), so background/startInBackground are DROPPED. Resume
// is no longer lost — it becomes EXPLICIT via `resumeFromRunId`.
import { z } from "zod";

const checkpointRepliesSchema = z
  .record(
    z.string().regex(/^(0|[1-9]\d*)$/, "checkpoint reply keys must be non-negative integer call indexes"),
    z.unknown(),
  )
  .transform(
    (replies) =>
      Object.fromEntries(Object.entries(replies).map(([callIndex, reply]) => [Number(callIndex), reply])) as Record<
        number,
        unknown
      >,
  );

export const workflowToolInputShape = {
  script: z
    .string()
    .min(1)
    .describe(
      "Required raw JavaScript workflow script (no Markdown fences). First statement MUST be `export const meta = { name, description, phases? }`; the script MUST call agent() at least once.",
    ),
  args: z.unknown().optional().describe("Optional JSON value exposed to the script as the global `args`."),
  maxAgents: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max agents allowed in this run. Default 1000 (engine cap MAX_AGENTS_PER_RUN)."),
  // PLAIN number — NO .max(). The engine clamps to MAX_CONCURRENCY (16).
  concurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max concurrent agents. CLAMPED to the runtime max (16) by the engine — not rejected."),
  // PLAIN number — NO .max(). The engine clamps to MAX_AGENT_RETRIES (3).
  agentRetries: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Retry attempts for recoverable agent failures. CLAMPED to the runtime max (3) by the engine."),
  agentTimeoutMs: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Per-agent timeout in ms. Omit/null for no hard timeout (the engine owns the timeout)."),
  tokenBudget: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Hard total-token budget for the whole run. Omit/null for no limit."),
  resumeFromRunId: z
    .string()
    .optional()
    .describe(
      "Resume a prior run from its persisted journal (the shell loads the journal by runId and passes it to the engine as resumeJournal). Replaces Pi's background result-delivery: resume is now EXPLICIT.",
    ),
  checkpointReplies: checkpointRepliesSchema
    .optional()
    .describe(
      "With resumeFromRunId, decisions for durable checkpoints keyed by checkpointContext.callIndex. JSON string keys are coerced to numeric call indexes and journaled before replay.",
    ),
} as const;

/** z.infer<z.ZodObject<typeof workflowToolInputShape>> — the handler's validated input. */
export interface WorkflowToolInput {
  script: string;
  args?: unknown;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number | null;
  tokenBudget?: number | null;
  resumeFromRunId?: string;
  checkpointReplies?: Record<number, unknown>;
}

/**
 * Handler-side CLAMP (NOT schema-encoded). Run on the validated input before handing it
 * to runWorkflow/runSync so out-of-range knobs degrade gracefully instead of throwing
 * InvalidParams. Mirrors the engine's own normalizeConcurrency/normalizeAgentRetries, so
 * even a direct engine caller gets the same result. NOTE: keeping the bounds out of the
 * Zod shape AND clamping here is the contract — do not move bounds into the wire schema.
 */
export function clampWorkflowInput(input: WorkflowToolInput): WorkflowToolInput {
  const clampInt = (v: number | undefined, lo: number, hi: number) =>
    v === undefined || !Number.isFinite(v) ? undefined : Math.min(hi, Math.max(lo, Math.floor(v)));
  return {
    ...input,
    concurrency: clampInt(input.concurrency, 1, 16), // MAX_CONCURRENCY
    agentRetries: clampInt(input.agentRetries, 0, 3), // MAX_AGENT_RETRIES
    maxAgents:
      input.maxAgents === undefined || !Number.isFinite(input.maxAgents)
        ? undefined
        : Math.max(1, Math.floor(input.maxAgents)),
  };
}

// Tool registration sketch (synchronous; clamp in; structuredContent + text out):
//   server.registerTool("workflow",
//     { inputSchema: workflowToolInputShape, outputSchema: workflowToolOutputShape },
//     async (raw, extra) => {
//       const input = clampWorkflowInput(raw);
//       const run = await manager.runSync(input, {
//         agent: createAcpRunner(),                 // REQUIRED AgentRunner injection (composition root)
//         signal: extra.signal,                     // engine-owned cancel
//         onProgress: (p, total, message) =>        // no-op when progressToken absent
//           extra.sendNotification?.({ method: "notifications/progress",
//             params: { progressToken: extra._meta?.progressToken, progress: p, total, message } }),
//       });
//       const structuredContent = toWorkflowToolResult(run);   // see workflow-tool-output.ts
//       return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }] };
//     });
