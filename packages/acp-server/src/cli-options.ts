import {
  DEFAULT_ACP_HTTP_BASE_PATH,
  DEFAULT_ACP_HTTP_HOST,
  DEFAULT_ACP_HTTP_PORT,
} from "./http-server.js";
import type { AcpServerEndpoint } from "./server.js";

export type CliOptions =
  | { readonly mode: "help" }
  | { readonly mode: "stdio"; readonly endpoint: AcpServerEndpoint }
  | {
      readonly mode: "http";
      readonly host: string;
      readonly port: number;
      readonly basePath: string;
    };

export function parseCliOptions(args: readonly string[]): CliOptions {
  let http = false;
  let discovery = false;
  let backendId: string | undefined;
  let host: string = DEFAULT_ACP_HTTP_HOST;
  let port: number = DEFAULT_ACP_HTTP_PORT;
  let basePath: string = DEFAULT_ACP_HTTP_BASE_PATH;
  let usedNetworkOption = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") return { mode: "help" };
    if (argument === "--http") {
      http = true;
      continue;
    }
    if (argument === "--discovery") {
      discovery = true;
      continue;
    }
    if (argument === "--backend" || argument.startsWith("--backend=")) {
      const parsed = readOptionValue(args, index, argument, "--backend");
      backendId = parsed.value;
      index = parsed.index;
      continue;
    }
    if (argument === "--host" || argument.startsWith("--host=")) {
      const parsed = readOptionValue(args, index, argument, "--host");
      host = parsed.value;
      index = parsed.index;
      usedNetworkOption = true;
      continue;
    }
    if (argument === "--port" || argument.startsWith("--port=")) {
      const parsed = readOptionValue(args, index, argument, "--port");
      port = parsePort(parsed.value);
      index = parsed.index;
      usedNetworkOption = true;
      continue;
    }
    if (argument === "--base-path" || argument.startsWith("--base-path=")) {
      const parsed = readOptionValue(args, index, argument, "--base-path");
      basePath = parsed.value;
      index = parsed.index;
      usedNetworkOption = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (http) {
    if (discovery || backendId !== undefined) {
      throw new Error("--http exposes every endpoint path and cannot be combined with --discovery or --backend");
    }
    return { mode: "http", host, port, basePath };
  }
  if (usedNetworkOption) throw new Error("--host, --port, and --base-path require --http");
  if (discovery === (backendId !== undefined)) {
    throw new Error("stdio mode requires exactly one of --discovery or --backend <id>");
  }
  return discovery
    ? { mode: "stdio", endpoint: { kind: "discovery" } }
    : { mode: "stdio", endpoint: { kind: "backend", backendId: backendId! } };
}

export function cliHelp(): string {
  return [
    "Usage:",
    "  agentprism-acp-server --discovery",
    "  agentprism-acp-server --backend <id>",
    "  agentprism-acp-server --http [--host <host>] [--port <port>] [--base-path <path>]",
    "",
    "Modes:",
    "  --discovery       Serve one stdio backend-discovery connection.",
    "  --backend <id>    Serve one stdio connection pinned to the named backend.",
    "  --http            Serve /discovery and /backends/{id} HTTP/WebSocket paths.",
    "",
    `Network defaults: ${DEFAULT_ACP_HTTP_HOST}:${DEFAULT_ACP_HTTP_PORT}${DEFAULT_ACP_HTTP_BASE_PATH}`,
  ].join("\n");
}

function readOptionValue(
  args: readonly string[],
  index: number,
  argument: string,
  name: string,
): { value: string; index: number } {
  const equals = argument.indexOf("=");
  if (equals >= 0) {
    const value = argument.slice(equals + 1);
    if (!value) throw new Error(`${name} requires a value`);
    return { value, index };
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, index: index + 1 };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`--port must be an integer from 0 through 65535, received ${JSON.stringify(value)}`);
  }
  return port;
}
