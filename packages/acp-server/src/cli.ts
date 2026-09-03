#!/usr/bin/env node
// Keep stdout reserved for ACP before importing modules that may log during evaluation.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  const manifest = await import("../package.json", { with: { type: "json" } }).then(
    (module) => module.default,
  );
  process.stdout.write(`${manifest.version}\n`);
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(`Usage:
  agentprism-acp-server
  agentprism-acp-server --http [--host <host>] [--port <port>] [--path <path>]

With no transport flag, the server speaks ACP over stdio. --http starts both
Streamable HTTP and WebSocket transports on one endpoint (default:
http://127.0.0.1:7331/acp and ws://127.0.0.1:7331/acp).
`);
  process.exit(0);
}

console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

const abortController = new AbortController();
process.once("SIGTERM", () => abortController.abort(new Error("SIGTERM")));
process.once("SIGINT", () => abortController.abort(new Error("SIGINT")));

try {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.mode === "stdio") {
    const { serveAcpServer } = await import("./server.js");
    await serveAcpServer({ signal: abortController.signal });
  } else {
    const { listenAcpHttpServer } = await import("./http-server.js");
    const server = await listenAcpHttpServer({
      host: options.host,
      port: options.port,
      path: options.path,
      signal: abortController.signal,
    });
    console.error(`ACP Streamable HTTP endpoint listening at ${server.url}`);
    console.error(`ACP WebSocket endpoint listening at ${server.webSocketUrl}`);
    await server.closed;
  }
} catch (error) {
  if (!abortController.signal.aborted) {
    console.error("ACP server failed:", error);
    process.exitCode = 1;
  }
}

type CliOptions =
  | { mode: "stdio" }
  | { mode: "http"; host: string; port: number; path: string };

function parseCliOptions(args: string[]): CliOptions {
  let http = false;
  let host = "127.0.0.1";
  let port = 7331;
  let path = "/acp";
  let networkOption = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--http") {
      http = true;
      continue;
    }
    if (argument === "--host" || argument === "--port" || argument === "--path") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      networkOption = true;
      index += 1;
      if (argument === "--host") host = value;
      if (argument === "--path") path = value;
      if (argument === "--port") port = parsePort(value);
      continue;
    }
    if (argument.startsWith("--host=")) {
      host = argument.slice("--host=".length);
      networkOption = true;
      continue;
    }
    if (argument.startsWith("--port=")) {
      port = parsePort(argument.slice("--port=".length));
      networkOption = true;
      continue;
    }
    if (argument.startsWith("--path=")) {
      path = argument.slice("--path=".length);
      networkOption = true;
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(argument)}; run with --help for usage`);
  }

  if (!http) {
    if (networkOption) throw new Error("--host, --port, and --path require --http");
    return { mode: "stdio" };
  }
  return { mode: "http", host, port, path };
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("--port must be an integer from 0 through 65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer from 0 through 65535");
  }
  return port;
}
