import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import { Convert, Errors } from "typebox/value";
import { LocalMcpHttpHost } from "./local-mcp-host.js";
import { toJsonSchema } from "./schema-strict.js";
import { validateValue } from "./structured-output.js";

export const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";
export const STRUCTURED_OUTPUT_SERVER_NAME = "structured_output";

export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  "Use this tool to return your final response in the requested structured format.\n\n" +
  "IMPORTANT:\n" +
  "- You MUST call this tool exactly once at the end of your response\n" +
  "- The input must be valid JSON matching the required schema\n" +
  "- Complete all necessary research and tool calls BEFORE calling this tool\n" +
  "- This tool provides your final answer - no further actions are taken after calling it";

interface Slot {
  readonly token: string;
  readonly schema: TSchema;
  readonly inputSchema: Tool["inputSchema"];
  captured: unknown;
}

export interface StructuredOutputToolRegistration {
  readonly url: string;
  /** Peek at the last valid capture without consuming it (the runner's single-turn read). */
  tryCaptured(): unknown | undefined;
  /** Return the captured value and clear the slot — a capture belongs to exactly one turn, so a
   *  long-lived registration never hands turn N's object to turn N+1. */
  takeCaptured(): unknown | undefined;
  release(): void;
}

/** Runner-scoped localhost MCP host. It binds only once a schema run actually needs injection. */
export class StructuredOutputToolHost extends LocalMcpHttpHost {
  protected readonly hostName = "StructuredOutput";
  private readonly slots = new Map<string, Slot>();

  async register(schema: TSchema): Promise<StructuredOutputToolRegistration> {
    const token = randomBytes(16).toString("hex");
    const slot: Slot = {
      token,
      schema,
      inputSchema: structuredToolInputSchema(schema),
      captured: undefined,
    };
    this.slots.set(token, slot);
    try {
      const port = await this.ensureListening();
      return {
        url: this.urlFor(token, port),
        tryCaptured: () => slot.captured,
        takeCaptured: () => {
          const captured = slot.captured;
          slot.captured = undefined;
          return captured;
        },
        release: once(() => {
          this.slots.delete(token);
        }),
      };
    } catch (error) {
      this.slots.delete(token);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.slots.clear();
    await this.closeServer();
  }

  protected mcpServerFor(token: string): Server | undefined {
    const slot = this.slots.get(token);
    return slot ? createMcpServer(slot) : undefined;
  }
}

export function structuredToolInputSchema(schema: TSchema): Tool["inputSchema"] {
  const json = toJsonSchema(schema);
  delete json.$schema;
  return json as Tool["inputSchema"];
}

function createMcpServer(slot: Slot): Server {
  const server = new Server(
    { name: "agentprism-structured-output", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, (): ListToolsResult => ({
    tools: [
      {
        name: STRUCTURED_OUTPUT_TOOL_NAME,
        description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
        inputSchema: slot.inputSchema,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, (request): CallToolResult => {
    if (request.params.name !== STRUCTURED_OUTPUT_TOOL_NAME) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
    const args = request.params.arguments ?? {};
    const validated = validateValue(args, slot.schema);
    if (validated !== undefined) {
      slot.captured = validated;
      return textResult("Structured output captured successfully.");
    }
    return textResult(rejectionText(args, slot.schema), true);
  });

  return server;
}

function textResult(text: string, isError?: boolean): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

/** The first three typebox validation errors of `value` against `schema`, one line. */
export function describeSchemaErrors(schema: TSchema, value: unknown): string {
  let converted: unknown;
  try {
    converted = Convert(schema, value);
  } catch {
    converted = value;
  }
  return Errors(schema, converted)
    .slice(0, 3)
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
}

function rejectionText(value: unknown, schema: TSchema): string {
  return [
    "Structured output rejected: arguments do not match the required schema.",
    describeSchemaErrors(schema, value),
    "Fix the arguments and call StructuredOutput again.",
  ]
    .filter(Boolean)
    .join(" ");
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}
