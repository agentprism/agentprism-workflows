#!/usr/bin/env node
import { cliHelp, parseCliOptions } from "./cli-options.js";
import { listenAcpHttpServer } from "./http-server.js";
import { serveAcpServer } from "./server.js";

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.mode === "help") {
    process.stdout.write(`${cliHelp()}\n`);
    return;
  }

  if (options.mode === "stdio") {
    await serveAcpServer({ endpoint: options.endpoint });
    return;
  }

  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const server = await listenAcpHttpServer({
      host: options.host,
      port: options.port,
      basePath: options.basePath,
      signal: abortController.signal,
    });
    process.stderr.write(`AgentPrism ACP discovery HTTP endpoint listening on ${server.discovery.url}\n`);
    process.stderr.write(
      `AgentPrism ACP discovery WebSocket endpoint listening on ${server.discovery.webSocketUrl}\n`,
    );
    for (const backend of server.backends) {
      process.stderr.write(`AgentPrism ACP backend ${backend.backendId} HTTP endpoint listening on ${backend.url}\n`);
      process.stderr.write(
        `AgentPrism ACP backend ${backend.backendId} WebSocket endpoint listening on ${backend.webSocketUrl}\n`,
      );
    }
    await server.closed;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
