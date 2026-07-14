// Shared test harness for the @automatalabs/mcp-server suite.
//
// NOT a test file (no `.test.ts` suffix => excluded from the `test/**/*.test.ts`
// runner glob); it is imported by the real suites. It provides:
//   - an in-memory MCP client<->server pair (the phase-3 smoke pattern: a Client and
//     the real createWorkflowServer talking over InMemoryTransport, no stdio/process),
//   - stub AgentRunner factories (the engine's frozen seam — run() returns the RAW
//     value: text when no schema), and
//   - HOME isolation so WorkflowManager run persistence (which lives under
//     ~/.agentprism/workflows/projects/<key>/runs, see workflow-paths.ts) writes into
//     a throwaway temp dir instead of the developer's real home.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRunner, RunOptions } from "@automatalabs/shared-types";

import { createWorkflowServer } from "../src/index.js";

// Redirect run-state persistence into a disposable home BEFORE any WorkflowManager is
// constructed. os.homedir() reads $HOME on POSIX, and workflowProjectPaths() derives
// the runs dir from it at manager-construction time (inside createWorkflowServer), so
// setting it here at module load — before any test creates a server — fully isolates
// the suite's on-disk runs (and lets resume load them back) without touching real $HOME.
export const TEST_HOME = mkdtempSync(join(tmpdir(), "agentprism-mcp-test-home-"));
process.env.HOME = TEST_HOME;
process.on("exit", () => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of the throwaway home */
  }
});

/**
 * Build an AgentRunner test double from a plain implementation. The seam's run() is
 * generic over the optional typebox schema (RunOptions<S> -> AgentResult<S>); our stubs
 * are schema-less and return raw text/JSON, so the structural object is bridged to the
 * generic interface with a single `as AgentRunner` (never `as any`). The impl receives
 * the prompt and the (defaulted) options bag, exactly as the engine calls it.
 */
export function makeRunner(
  impl: (prompt: string, options: RunOptions) => unknown | Promise<unknown>,
): AgentRunner {
  const run = async (prompt: string, options?: RunOptions): Promise<unknown> => impl(prompt, options ?? {});
  return { run } as AgentRunner;
}

/** A runner that echoes a deterministic, non-empty text reply for every agent() call. */
export function okRunner(reply: (prompt: string) => string = (p) => `stub:${p}`): AgentRunner {
  return makeRunner((prompt) => reply(prompt));
}

/** A runner that throws the SAME error on every call (drives the engine's pause/fail paths). */
export function throwingRunner(makeError: () => unknown): AgentRunner {
  return makeRunner(() => {
    throw makeError();
  });
}

/**
 * A runner that counts how many times the engine actually invokes it. On resume the
 * engine replays the journal WITHOUT calling run(), so the count staying flat is the
 * proof that replay (not re-execution) happened.
 */
export function countingRunner(): { runner: AgentRunner; calls: () => number } {
  let n = 0;
  const runner = makeRunner((prompt) => {
    n += 1;
    return `r:${prompt}:${n}`;
  });
  return { runner, calls: () => n };
}

export interface Connected {
  client: Client;
  server: McpServer;
  dispose: () => Promise<void>;
}

/**
 * Wire a fresh in-memory MCP client to a real workflow server backed by `runner`.
 *
 * `listTools` (default false): when true the client lists tools first, which caches the
 * advertised outputSchema validator — so subsequent callTool results are validated
 * client-side against the published schema (the realistic host path). Leave it false to
 * exercise pure shell routing without the client-side output-schema gate.
 */
export async function connect(runner: AgentRunner, opts: { listTools?: boolean } = {}): Promise<Connected> {
  const server = createWorkflowServer(runner);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-server-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  if (opts.listTools) await client.listTools();
  return {
    client,
    server,
    async dispose() {
      await client.close();
      await server.close();
    },
  };
}

export type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

// The SDK types callTool's result fields through an index signature (unknown). These
// accessors re-assert the documented CallToolResult shape with precise casts (never
// `as any`) so the suites read structured fields type-safely.
type TextBlock = { type: string; text?: string };

/** The validated structuredContent as a keyed bag (undefined on a thrown-error result). */
export function structured(res: ToolCallResult): Record<string, unknown> | undefined {
  return res.structuredContent as Record<string, unknown> | undefined;
}

/** Read the first text content block (the human-readable summary the shell emits). */
export function textOf(res: ToolCallResult): string {
  const blocks = (res.content as TextBlock[] | undefined) ?? [];
  const block = blocks.find((c) => c.type === "text");
  return typeof block?.text === "string" ? block.text : "";
}

/** Locate one isolated persisted run fixture without exposing a production persistence path. */
export function persistedRunFile(runId: string): string | undefined {
  const root = join(TEST_HOME, ".agentprism", "workflows");
  const visit = (dir: string): string | undefined => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = visit(path);
        if (found) return found;
      } else if (entry.name === `${runId}.json`) {
        return path;
      }
    }
    return undefined;
  };
  return visit(root);
}

/** Valid one-agent script: meta first, exactly one agent() call, returns its result. */
export const ONE_AGENT_SCRIPT = [
  'export const meta = { name: "one-agent", description: "a single subagent" };',
  'const r = await agent("hello");',
  "return r;",
].join("\n");

/** Valid script with NO agent() call — completes immediately with a plain return value. */
export const NO_AGENT_SCRIPT = [
  'export const meta = { name: "no-agent", description: "no subagents" };',
  "return 42;",
].join("\n");

/** Two sequential agent() calls — used to prove resume replays the whole journaled prefix. */
export const TWO_AGENT_SCRIPT = [
  'export const meta = { name: "two-agent", description: "two sequential subagents" };',
  'const a = await agent("alpha");',
  'const b = await agent("beta");',
  "return { a, b };",
].join("\n");
