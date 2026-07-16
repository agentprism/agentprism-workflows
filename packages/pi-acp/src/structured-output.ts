import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { adapterError } from "./errors.js";

export const STRUCTURED_TOOL_NAME = "__acp_structured_output";

export class StructuredOutputState {
  readonly tool: ToolDefinition;
  private readonly schemaHolder = Type.Any();
  private captured: unknown;
  private baseActive: string[] = [];

  constructor() {
    const tool = {
      name: STRUCTURED_TOOL_NAME,
      label: "Structured output",
      description: "Return the final response as structured data matching the requested schema.",
      parameters: this.schemaHolder,
      execute: async (_toolCallId: string, params: unknown) => {
        this.captured = params;
        return {
          content: [{ type: "text" as const, text: "(structured output captured)" }],
          details: params,
          terminate: true,
        };
      },
    };
    this.tool = tool as ToolDefinition;
  }

  install(session: AgentSession): void {
    if (!session.getToolDefinition(STRUCTURED_TOOL_NAME)) {
      throw adapterError("structured_tool_collision");
    }
    this.baseActive = session.getActiveToolNames().filter((name) => name !== STRUCTURED_TOOL_NAME);
    session.setActiveToolsByName(this.baseActive);
  }

  arm(session: AgentSession, schema: unknown): string {
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      throw adapterError("invalid_output_schema");
    }
    this.captured = undefined;
    const holder = this.schemaHolder as unknown as Record<string, unknown>;
    for (const key of Object.keys(holder)) delete holder[key];
    Object.assign(holder, schema);
    session.setActiveToolsByName([...this.baseActive, STRUCTURED_TOOL_NAME]);
    return "Finish by calling __acp_structured_output with a value conforming to the requested output schema.";
  }

  disarm(session: AgentSession): void {
    session.setActiveToolsByName(this.baseActive);
    this.captured = undefined;
  }

  takeJson(): string | undefined {
    if (this.captured === undefined) return undefined;
    try {
      return JSON.stringify(this.captured);
    } catch {
      return undefined;
    }
  }
}
