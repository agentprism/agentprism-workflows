import { randomBytes } from "node:crypto";
import http, {
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

const HOST = "127.0.0.1";

interface Slot {
  readonly token: string;
  readonly schema: TSchema;
  readonly inputSchema: Tool["inputSchema"];
  captured: unknown;
}

export interface StructuredOutputToolRegistration {
  readonly url: string;
  tryCaptured(): unknown | undefined;
  release(): void;
}

/** Runner-scoped localhost MCP host. It binds only once a schema run actually needs injection. */
export class StructuredOutputToolHost {
  private readonly slots = new Map<string, Slot>();
  private server: HttpServer | undefined;
  private listenPromise: Promise<void> | undefined;
  private port: number | undefined;

  isListening(): boolean {
    return this.server?.listening === true;
  }

  listeningPort(): number | undefined {
    return this.port;
  }

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
        url: `http://${HOST}:${port}/${token}`,
        tryCaptured: () => slot.captured,
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
    const server = this.server;
    this.server = undefined;
    this.listenPromise = undefined;
    this.port = undefined;
    if (!server || !server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async ensureListening(): Promise<number> {
    if (!this.server) {
      this.server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      this.server.unref();
    }
    if (!this.listenPromise) {
      this.listenPromise = new Promise<void>((resolve, reject) => {
        const server = this.server!;
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("StructuredOutput MCP server did not bind to a TCP port"));
            return;
          }
          this.port = (address as AddressInfo).port;
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, HOST);
      });
    }
    await this.listenPromise;
    if (this.port === undefined) {
      throw new Error("StructuredOutput MCP server has no listening port");
    }
    return this.port;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const slot = this.slotFor(req);
    if (!slot) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer(slot);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(error instanceof Error ? error.message : String(error));
      } else {
        res.destroy(error instanceof Error ? error : undefined);
      }
    } finally {
      await Promise.allSettled([server.close(), transport.close()]);
    }
  }

  private slotFor(req: IncomingMessage): Slot | undefined {
    const rawUrl = req.url ?? "/";
    let pathname: string;
    try {
      pathname = new URL(rawUrl, `http://${HOST}`).pathname;
    } catch {
      return undefined;
    }
    if (!pathname.startsWith("/") || pathname.slice(1).includes("/")) return undefined;
    const token = pathname.slice(1);
    if (!token) return undefined;
    return this.slots.get(token);
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

function rejectionText(value: unknown, schema: TSchema): string {
  let converted: unknown;
  try {
    converted = Convert(schema, value);
  } catch {
    converted = value;
  }
  const details = Errors(schema, converted)
    .slice(0, 3)
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  return [
    "Structured output rejected: arguments do not match the required schema.",
    details,
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
