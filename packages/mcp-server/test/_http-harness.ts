// HTTP-transport sibling of _harness.ts: a real createDaemon() on an ephemeral loopback
// port, driven by real SDK Clients over StreamableHTTPClientTransport. Importing _harness
// first inherits its $HOME isolation, stub runner factories, and result accessors.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentRunner } from "@automatalabs/shared-types";

import { TEST_HOME, makeRunner } from "./_harness.js";
import { createDaemon, type DaemonHandle } from "../src/daemon/http-daemon.js";

export async function startDaemon(runner: AgentRunner): Promise<DaemonHandle> {
  return createDaemon({
    runner,
    port: 0,
    env: {},
    log: () => undefined,
  });
}

/** A real directory to bind sessions to (resolveProjectDir realpaths and stats it). */
export function makeProjectDir(prefix: string): string {
  return mkdtempSync(join(TEST_HOME, `${prefix}-`));
}

export interface HttpConnected {
  client: Client;
  transport: StreamableHTTPClientTransport;
  elicitations: ElicitRequest[];
  resourceUpdates: string[];
  dispose: () => Promise<void>;
}

export async function connectHttp(
  url: string,
  opts: {
    listTools?: boolean;
    /** Advertise the elicitation capability and answer checkpoint forms with this. */
    elicit?: (request: ElicitRequest) => ElicitResult | Promise<ElicitResult>;
  } = {},
): Promise<HttpConnected> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client(
    { name: "mcp-http-test", version: "0.0.0" },
    { capabilities: opts.elicit ? { elicitation: {} } : {} },
  );
  const elicitations: ElicitRequest[] = [];
  if (opts.elicit) {
    const respond = opts.elicit;
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitations.push(request);
      return await respond(request);
    });
  }
  const resourceUpdates: string[] = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
    resourceUpdates.push(notification.params.uri);
  });
  await client.connect(transport);
  if (opts.listTools) await client.listTools();
  return {
    client,
    transport,
    elicitations,
    resourceUpdates,
    async dispose() {
      await client.close().catch(() => undefined);
    },
  };
}

export async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A runner whose calls all block on one gate the test releases. */
export function gatedRunner(): { runner: AgentRunner; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = makeRunner(async (prompt) => {
    await gate;
    return `done:${prompt}`;
  });
  return { runner, release };
}
